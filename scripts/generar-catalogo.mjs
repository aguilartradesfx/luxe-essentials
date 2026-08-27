// scripts/generar-catalogo.mjs
// Genera lib/cotizador/catalogo.ts desde precios/*.xlsx.
// Requiere: pip3 install openpyxl (solo para desarrollo, no es dependencia del proyecto).
// Ejecutar: node scripts/generar-catalogo.mjs
//
// Ronda de correcciones 1 (revisor): el generador ahora valida lo que LEE, no solo
// lo que produce. Un índice de fila corrido (Luxe inserta o borra una fila arriba)
// debe hacer que este script explote con un mensaje que diga qué fila no cuadra,
// nunca que produzca un catálogo silenciosamente incorrecto.
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

// Debe coincidir con TALLAS de lib/cotizador/tipos.ts. Se duplica a propósito:
// este script no compila TypeScript, y es un solo array de cuatro strings.
const TALLAS = ['king', 'queen', 'doble', 'imperial'];

// Encabezados de sección que aparecen en las hojas. Si una fila corrida hace que
// un "producto" termine siendo en realidad uno de estos textos, es una señal
// inequívoca de que el índice ya no apunta a donde creíamos.
const ENCABEZADOS_CONOCIDOS = [
  'set de 600 hilos', 'set de 400 hilos', 'set de 300 hilos', 'set de 200 hilos',
  'funda de duvet 300 hilos', 'funda de duvet rayada 200 hilos',
  'inserto de duvet', 'pillow top',
  'toallas 680 gm 5*', 'toallas 460 gm 5*', 'toallas 360 gm 4*', 'almohadas',
];

function validarSku(sku, fila) {
  const nombre = String(sku.nombre ?? '').trim();
  if (!nombre) {
    throw new Error(`Fila ${fila}: nombre vacío para "${sku.id}". Es probable que el índice de fila ya no apunte a un producto.`);
  }
  if (ENCABEZADOS_CONOCIDOS.includes(nombre.toLowerCase())) {
    throw new Error(`Fila ${fila}: "${nombre}" es un encabezado de sección, no un producto. Revisar si se insertó o borró una fila arriba.`);
  }
  if (!Number.isInteger(sku.precioLista) || sku.precioLista <= 0) {
    throw new Error(`Fila ${fila}: precio inválido (${JSON.stringify(sku.precioLista)}) para "${sku.id}".`);
  }
  if (sku.talla && !TALLAS.includes(sku.talla)) {
    throw new Error(`Fila ${fila}: talla "${sku.talla}" desconocida para "${sku.id}" (esperaba una de ${TALLAS.join(', ')}).`);
  }
}

const skus = [];

// --- Uniformes: se corta por contenido, no por índice fijo ---
// Antes: `slice(6, 28)`, una ventana fija que ni agrega un uniforme nuevo ni
// avisa si Luxe quita uno. Ahora: se busca el encabezado "DESCRIPTION", se
// saltan las filas en blanco que sigan, y se lee hasta la primera fila vacía.
// Si Luxe agrega una fila 29, entra sola y el conteo final de 70 avisa que la
// composición del catálogo cambió (hay que decidir a qué grupo va).
//
// Correcciones de nombre de cara al cliente (ronda 1 de revisión): la hoja
// viene en MAYÚSCULAS sin tildes; el resto del catálogo sí lleva tildes
// ("toalla de baño", "1 sábana", "bata blanca talla única"), así que dejarlo
// así se ve descuidado en una cotización que recibe un hotel. También se
// corrige una errata del archivo ("tradiciona" → "tradicional", fila 13, la
// fila 12 hermana sí dice "tradicional") y se capitalizan nombres propios de
// marca/estilo (Lacoste, Columbia, Oxford). El id se corrige junto con el
// nombre: hoy nada depende de los ids, así que es gratis.
const CORRECCIONES_TEXTO_UNIFORMES = {
  'FILIPINA TRADICIONAL CORTE MUJER M. CORTA': 'filipina tradicional corte mujer manga corta',
  'PANTALON DE COCINA TIPO BAGGY': 'pantalón de cocina tipo baggy',
  'PANTALON DE COCINA TIPO BAGGY CORTE MUJER': 'pantalón de cocina tipo baggy corte mujer',
  'PANTALON TRADICIONAL FORMAL': 'pantalón tradicional formal',
  'PANTALON TRADICIONA FORMAL CORTE MUJER': 'pantalón tradicional formal corte mujer',
  'CAMISA TIPO POLO WARP PIQUE (TIPO LACOSTE)': 'camisa tipo polo warp piqué (tipo Lacoste)',
  'CAMISA TIPO POLO WARP PIQUE CORTE MUJER': 'camisa tipo polo warp piqué corte mujer',
  'CAMISA TIPO COLUMBIA': 'camisa tipo Columbia',
  'CAMISA TIPO COLUMBIA CORTE MUJER': 'camisa tipo Columbia corte mujer',
  'CAMISA FORMAL OXFORD MANGA CORTA': 'camisa formal Oxford manga corta',
  'CAMISA FORMAL OXFORD MANGA CORTA CORTE MUJER': 'camisa formal Oxford manga corta corte mujer',
};

const filaEncabezadoUniformes = datos.uniformes.findIndex(
  (f) => String(f[0] ?? '').trim().toUpperCase() === 'DESCRIPTION',
) + 1; // a fila 1-index
if (filaEncabezadoUniformes === 0) {
  throw new Error('No se encontró el encabezado "DESCRIPTION" en uniformes-2026.xlsx: revisar si cambió la hoja.');
}

let filaUniforme = filaEncabezadoUniformes + 1;
while (
  filaUniforme <= datos.uniformes.length &&
  !String(datos.uniformes[filaUniforme - 1]?.[0] ?? '').trim()
) {
  filaUniforme++; // salta filas en blanco entre el encabezado y el primer uniforme
}

let uniformesLeidos = 0;
for (; filaUniforme <= datos.uniformes.length; filaUniforme++) {
  const cruda = datos.uniformes[filaUniforme - 1];
  const nombreCrudo = String(cruda?.[0] ?? '').trim();
  if (!nombreCrudo) break; // fila en blanco: fin del bloque
  const precioCrudo = cruda[1];
  if (typeof precioCrudo !== 'number') {
    throw new Error(`Fila ${filaUniforme} de uniformes: "${nombreCrudo}" no tiene un precio numérico en la columna B.`);
  }
  const corregido = CORRECCIONES_TEXTO_UNIFORMES[nombreCrudo.toUpperCase()] ?? nombreCrudo.toLowerCase();
  const sku = {
    id: `uni-${slug(corregido)}`, linea: 'uniformes', grupo: 'uniformes',
    familia: 'Uniformes', nombre: corregido, precioLista: precioCrudo,
  };
  validarSku(sku, filaUniforme);
  skus.push(sku);
  uniformesLeidos++;
}
if (uniformesLeidos === 0) {
  throw new Error(`No se leyó ningún uniforme después de la fila ${filaEncabezadoUniformes}. Revisar la hoja.`);
}

// --- Ropa de cama ---
const CONTENIDO_2 = ['1 cubrecama', '1 sábana', '2 sobrefundas'];
const CONTENIDO_1 = ['1 cubrecama', '1 sábana', '1 sobrefunda'];
const contenidoDe = (talla) => (talla === 'imperial' ? CONTENIDO_1 : CONTENIDO_2);

const fila = (n) => datos.cama[n - 1];
const nom = (n) => String(fila(n)?.[0] ?? '').trim();
const precio = (n) => fila(n)?.[1];

// Confirma que la fila `numero` todavía dice lo que el índice fijo asume. Si
// alguien insertó o borró una fila arriba, esto revienta señalando cuál.
function verificarFila(numero, sustringEsperado, contexto) {
  const texto = nom(numero).toLowerCase();
  if (!texto.includes(sustringEsperado.toLowerCase())) {
    throw new Error(
      `Fila ${numero} (${contexto}): se esperaba un texto que incluyera "${sustringEsperado}" ` +
      `y el archivo dice "${nom(numero)}". Es probable que se haya insertado o borrado una fila ` +
      `arriba en precios/ropa-de-cama-2026.xlsx: revisar antes de regenerar.`,
    );
  }
}

// Sets: filas 7-10, 12-15, 17-20, 22-25. Familia por conteo de hilos.
for (const [hilos, desde] of [[600, 7], [400, 12], [300, 17], [200, 22]]) {
  verificarFila(desde - 1, `set de ${hilos} hilos`, `encabezado set ${hilos} hilos`);
  for (let r = desde; r < desde + 4; r++) {
    const talla = nom(r);
    const sku = {
      id: `set-${hilos}-${talla}`, linea: 'hogar', grupo: 'sets-cama',
      familia: `Sets de cama ${hilos} hilos`,
      nombre: `set de ${hilos} hilos ${talla}`, talla,
      precioLista: precio(r), contenido: contenidoDe(talla),
    };
    validarSku(sku, r);
    skus.push(sku);
  }
}

// Fundas e insertos: filas 28-31, 33-36, 38-41, 43-46. Un solo grupo.
for (const [familia, desde, anclaEncabezado] of [
  ['Fundas de duvet 300 hilos', 28, 'funda de duvet 300 hilos'],
  ['Fundas de duvet rayadas 200 hilos', 33, 'funda de duvet rayada'],
  ['Insertos de duvet', 38, 'inserto de duvet'],
  ['Pillow tops', 43, 'pillow top'],
]) {
  verificarFila(desde - 1, anclaEncabezado, `encabezado ${familia}`);
  for (let r = desde; r < desde + 4; r++) {
    const nombre = nom(r);
    const sku = {
      id: slug(nombre), linea: 'hogar', grupo: 'fundas-insertos',
      familia, nombre, talla: nombre.split(' ').pop(), precioLista: precio(r),
    };
    validarSku(sku, r);
    skus.push(sku);
  }
}

// Toallas: 680gm filas 51-54, 460gm 58-61, 360gm 65-68.
// Se omiten las filas 55, 62 y 69: Luxe confirmó que la toalla de pie es una
// sola, sin gramaje. Se agrega aparte, más abajo, leyendo (y validando) su
// precio de la hoja en vez de un literal ciego.
for (const [gramaje, desde] of [[680, 51], [460, 58], [360, 65]]) {
  verificarFila(desde - 1, `toallas ${gramaje}`, `encabezado toallas ${gramaje}gm`);
  for (let r = desde; r < desde + 4; r++) {
    const nombre = nom(r);
    const sku = {
      id: `toalla-${gramaje}-${slug(nombre.replace('toalla de ', '').replace('toalla ', ''))}`,
      linea: 'hogar', grupo: 'toallas', familia: `Toallas ${gramaje} gm`,
      nombre: `${nombre} ${gramaje} gm`, precioLista: precio(r),
    };
    validarSku(sku, r);
    skus.push(sku);
  }
}

// La toalla de pie: el archivo trae tres filas (una por gramaje) con precios
// que no concuerdan entre sí (680gm y 460gm en 5000, 360gm en 3000 — ver
// precios/README.md). Luxe confirmó una sola toalla de pie, sin gramaje, a
// 5000. En vez de un literal que nunca lee la hoja, se valida cada una de las
// tres filas contra el valor que sabíamos al momento de esta corrección: si
// alguna cambió, hay que volver a preguntarle a Luxe antes de regenerar.
function leerToallaDePieValidada(numeroFila, gramaje, valorEsperadoEnArchivo) {
  verificarFila(numeroFila, 'toalla de pie', `toalla de pie ${gramaje}gm`);
  const valor = precio(numeroFila);
  if (valor !== valorEsperadoEnArchivo) {
    throw new Error(
      `La toalla de pie ${gramaje}gm (fila ${numeroFila}) vale ${valor} en el archivo, ` +
      `se esperaba ${valorEsperadoEnArchivo}. Luxe pudo haber cambiado el precio: confirmar ` +
      `antes de mantener la corrección a una sola toalla de pie de ₡5.000 (ver precios/README.md).`,
    );
  }
  return valor;
}
leerToallaDePieValidada(55, 680, 5000);
leerToallaDePieValidada(62, 460, 5000);
leerToallaDePieValidada(69, 360, 3000);
const toallaDePie = {
  id: 'toalla-de-pie', linea: 'hogar', grupo: 'toallas',
  familia: 'Toallas', nombre: 'toalla de pie', precioLista: 5000,
};
validarSku(toallaDePie, 55);
skus.push(toallaDePie);

// Bata: fila 48. Grupo propio.
verificarFila(48, 'bata blanca', 'bata');
const bata = {
  id: 'bata-blanca', linea: 'hogar', grupo: 'bata', familia: 'Toallas',
  nombre: 'bata blanca talla única', precioLista: precio(48),
};
validarSku(bata, 48);
skus.push(bata);

// Almohadas: filas 72-73. El precio es por paquete.
verificarFila(71, 'almohadas', 'encabezado almohadas');
for (const r of [72, 73]) {
  const nombre = nom(r).replace(/\s+/g, ' ');
  const sku = {
    id: `almohada-${slug(nombre)}`, linea: 'hogar', grupo: 'almohadas',
    familia: 'Almohadas', nombre, precioLista: precio(r),
  };
  validarSku(sku, r);
  skus.push(sku);
}

// --- Correcciones de precio confirmadas por Luxe, posteriores al archivo ---
// Detalle en precios/README.md. El archivo trae la facial y la de mano
// invertidas en 680gm; con la corrección la facial queda más barata que la de
// mano en los tres gramajes, que es el patrón coherente.
//
// `corregir` valida el valor que el archivo trae HOY, no solo que el id
// exista: si la próxima lista ya trae el precio corregido (o uno distinto de
// nuevo), esto revienta en vez de pisar un precio legítimo en silencio.
const corregir = (id, valorEsperadoEnArchivo, valorCorregido) => {
  const sku = skus.find((s) => s.id === id);
  if (!sku) throw new Error(`No se encontró para corregir: ${id}`);
  if (sku.precioLista !== valorEsperadoEnArchivo) {
    throw new Error(
      `Corrección de "${id}" ya no aplica: el archivo dice ${sku.precioLista}, se esperaba ` +
      `${valorEsperadoEnArchivo} (ver precios/README.md). Revisar si Luxe ya corrigió este ` +
      `precio antes de mantener el parche.`,
    );
  }
  sku.precioLista = valorCorregido;
};
corregir('toalla-680-facial', 3500, 3000);
corregir('toalla-680-mano', 3000, 3500);

// --- Correcciones de nombre confirmadas por Luxe, de cara al cliente ---
// El campo `nombre` es literalmente lo que lee un hotel en la cotización. No
// son ruido: se corrigen a propósito y quedan documentadas para que la
// próxima regeneración no las pise sin querer.
// - "funda king" es ambiguo en este catálogo (hay sobrefundas dentro de los
//   sets y fundas de almohada): se completa con la familia, igual que su
//   hermana de 200 hilos rayada.
// - "king 2 unidades por paquete" no dice en ningún lado que es una almohada.
const CORRECCIONES_NOMBRE = {
  'funda-king': 'funda de duvet 300 hilos king',
  'funda-queen': 'funda de duvet 300 hilos queen',
  'funda-doble': 'funda de duvet 300 hilos doble',
  'funda-imperial': 'funda de duvet 300 hilos imperial',
  'almohada-king-2-unidades-por-paquete': 'almohada king (paquete de 2 unidades)',
  'almohada-queen-4-unidades-por-paquete': 'almohada queen (paquete de 4 unidades)',
};
for (const [id, nombre] of Object.entries(CORRECCIONES_NOMBRE)) {
  const sku = skus.find((s) => s.id === id);
  if (!sku) throw new Error(`No se encontró para corregir el nombre: ${id}`);
  sku.nombre = nombre;
}

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
