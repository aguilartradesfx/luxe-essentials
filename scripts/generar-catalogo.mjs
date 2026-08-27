// scripts/generar-catalogo.mjs
// Genera lib/cotizador/catalogo.ts desde precios/*.xlsx.
// Requiere: pip3 install openpyxl (solo para desarrollo, no es dependencia del proyecto).
// Ejecutar: node scripts/generar-catalogo.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const PY = `
import json, openpyxl
u = openpyxl.load_workbook("precios/uniformes-2026.xlsx", data_only=True).worksheets[0]
c = openpyxl.load_workbook("precios/ropa-de-cama-2026.xlsx", data_only=True).worksheets[0]
def celdas(ws):
    return [[ws.cell(r,col).value for col in range(1,5)] for r in range(1, ws.max_row+1)]
print(json.dumps({"uniformes": celdas(u), "cama": celdas(c)}))
`;
const datos = JSON.parse(execFileSync('python3', ['-c', PY], { encoding: 'utf8' }));

const slug = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const skus = [];

// --- Uniformes: filas 7 a 28, un grupo único ---
for (const [nombre, lista] of datos.uniformes.slice(6, 28).map((f) => [f[0], f[1]])) {
  if (typeof lista !== 'number') continue;
  const limpio = String(nombre).trim();
  skus.push({
    id: `uni-${slug(limpio)}`, linea: 'uniformes', grupo: 'uniformes',
    familia: 'Uniformes', nombre: limpio.toLowerCase(), precioLista: lista,
  });
}

// --- Ropa de cama ---
const CONTENIDO_2 = ['1 cubrecama', '1 sábana', '2 sobrefundas'];
const CONTENIDO_1 = ['1 cubrecama', '1 sábana', '1 sobrefunda'];
const contenidoDe = (talla) => (talla === 'imperial' ? CONTENIDO_1 : CONTENIDO_2);

const fila = (n) => datos.cama[n - 1];
const nom = (n) => String(fila(n)[0] ?? '').trim();
const precio = (n) => fila(n)[1];

// Sets: filas 7-10, 12-15, 17-20, 22-25. Familia por conteo de hilos.
for (const [hilos, desde] of [[600, 7], [400, 12], [300, 17], [200, 22]]) {
  for (let r = desde; r < desde + 4; r++) {
    const talla = nom(r);
    skus.push({
      id: `set-${hilos}-${talla}`, linea: 'hogar', grupo: 'sets-cama',
      familia: `Sets de cama ${hilos} hilos`,
      nombre: `set de ${hilos} hilos ${talla}`, talla,
      precioLista: precio(r), contenido: contenidoDe(talla),
    });
  }
}

// Fundas e insertos: filas 28-31, 33-36, 38-41, 43-46. Un solo grupo.
for (const [familia, desde] of [
  ['Fundas de duvet 300 hilos', 28], ['Fundas de duvet rayadas 200 hilos', 33],
  ['Insertos de duvet', 38], ['Pillow tops', 43],
]) {
  for (let r = desde; r < desde + 4; r++) {
    const nombre = nom(r);
    skus.push({
      id: slug(nombre), linea: 'hogar', grupo: 'fundas-insertos',
      familia, nombre, talla: nombre.split(' ').pop(), precioLista: precio(r),
    });
  }
}

// Toallas: 680gm filas 51-54, 460gm 58-61, 360gm 65-68.
// Se omiten las filas 55, 62 y 69: Luxe confirmó que la toalla de pie es una
// sola, sin gramaje. Se agrega aparte, más abajo.
for (const [gramaje, desde] of [[680, 51], [460, 58], [360, 65]]) {
  for (let r = desde; r < desde + 4; r++) {
    const nombre = nom(r);
    skus.push({
      id: `toalla-${gramaje}-${slug(nombre.replace('toalla de ', '').replace('toalla ', ''))}`,
      linea: 'hogar', grupo: 'toallas', familia: `Toallas ${gramaje} gm`,
      nombre: `${nombre} ${gramaje} gm`, precioLista: precio(r),
    });
  }
}
skus.push({
  id: 'toalla-de-pie', linea: 'hogar', grupo: 'toallas',
  familia: 'Toallas', nombre: 'toalla de pie', precioLista: 5000,
});

// Bata: fila 48. Grupo propio.
skus.push({
  id: 'bata-blanca', linea: 'hogar', grupo: 'bata', familia: 'Toallas',
  nombre: 'bata blanca talla única', precioLista: precio(48),
});

// Almohadas: filas 72-73. El precio es por paquete.
for (const r of [72, 73]) {
  const nombre = nom(r).replace(/\s+/g, ' ');
  skus.push({
    id: `almohada-${slug(nombre)}`, linea: 'hogar', grupo: 'almohadas',
    familia: 'Almohadas', nombre, precioLista: precio(r),
  });
}

// --- Correcciones confirmadas por Luxe, posteriores al archivo ---
// Detalle en precios/README.md. El archivo trae la facial y la de mano
// invertidas en 680gm; con la corrección la facial queda más barata que la de
// mano en los tres gramajes, que es el patrón coherente.
const corregir = (id, precioLista) => {
  const sku = skus.find((s) => s.id === id);
  if (!sku) throw new Error(`No se encontró para corregir: ${id}`);
  sku.precioLista = precioLista;
};
corregir('toalla-680-facial', 3000);
corregir('toalla-680-mano', 3500);

if (skus.length !== 70) {
  throw new Error(`Se esperaban 70 SKUs y salieron ${skus.length}`);
}

const cabecera = `// GENERADO por scripts/generar-catalogo.mjs desde precios/*.xlsx.
// No editar a mano: la próxima regeneración lo pisa. Para cambiar un precio,
// se corrige el .xlsx (o el bloque de correcciones del script) y se regenera.
//
// Incluye las correcciones que Luxe confirmó por escrito y que no están en el
// archivo. Ver precios/README.md antes de cargar una lista nueva.
import type { Sku } from '@/lib/cotizador/tipos';

export const CATALOGO: Sku[] = `;

const pie = `;

const PORID = new Map(CATALOGO.map((s) => [s.id, s]));

export function buscarSku(id: string): Sku | undefined {
  return PORID.get(id);
}
`;

writeFileSync('lib/cotizador/catalogo.ts', cabecera + JSON.stringify(skus, null, 2) + pie);
console.log(`Escritos ${skus.length} SKUs en lib/cotizador/catalogo.ts`);
