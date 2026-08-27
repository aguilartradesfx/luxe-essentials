// tests/cotizador-catalogo.test.ts
import { describe, it, expect } from 'vitest';
import { CATALOGO, buscarSku } from '@/lib/cotizador/catalogo';
import { ESCALAS } from '@/lib/cotizador/escalas';
import { GRUPOS, TALLAS, LINEAS_CATALOGO } from '@/lib/cotizador/tipos';

describe('CATALOGO', () => {
  it('tiene los 70 SKUs', () => {
    expect(CATALOGO).toHaveLength(70);
  });

  it('reparte los SKUs por grupo como confirmó Luxe', () => {
    const conteo: Record<string, number> = {};
    for (const s of CATALOGO) conteo[s.grupo] = (conteo[s.grupo] ?? 0) + 1;
    expect(conteo).toEqual({
      uniformes: 22,
      'sets-cama': 16,
      'fundas-insertos': 16,
      toallas: 13,
      bata: 1,
      almohadas: 2,
    });
  });

  it('no repite ids', () => {
    const ids = CATALOGO.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('usa solo grupos, líneas y tallas conocidos', () => {
    for (const s of CATALOGO) {
      expect(GRUPOS).toContain(s.grupo);
      expect(LINEAS_CATALOGO).toContain(s.linea);
      if (s.talla) expect(TALLAS).toContain(s.talla);
      expect(ESCALAS[s.grupo]).toBeDefined();
    }
  });

  it('tiene precios enteros y positivos', () => {
    for (const s of CATALOGO) {
      expect(Number.isInteger(s.precioLista)).toBe(true);
      expect(s.precioLista).toBeGreaterThan(0);
    }
  });

  it('desglosa el contenido de todos los sets de cama y de nada más', () => {
    for (const s of CATALOGO) {
      if (s.grupo === 'sets-cama') expect(s.contenido?.length).toBeGreaterThan(0);
      else expect(s.contenido).toBeUndefined();
    }
  });

  it('da 1 sobrefunda a imperial y 2 al resto', () => {
    for (const s of CATALOGO.filter((x) => x.grupo === 'sets-cama')) {
      const esperado = s.talla === 'imperial' ? '1 sobrefunda' : '2 sobrefundas';
      expect(s.contenido).toContain(esperado);
    }
  });

  it('lleva las correcciones que Luxe confirmó después del archivo', () => {
    expect(buscarSku('toalla-680-facial')!.precioLista).toBe(3000);
    expect(buscarSku('toalla-680-mano')!.precioLista).toBe(3500);
    expect(buscarSku('toalla-de-pie')!.precioLista).toBe(5000);
  });

  it('tiene una sola toalla de pie', () => {
    // Ronda de correcciones 2 (hallazgo I3): los nombres del catálogo ahora
    // van con la primera letra en mayúscula ("Toalla de pie", no "toalla de
    // pie") — se busca sin distinguir mayúsculas para no acoplar esta
    // prueba al formato exacto del rótulo.
    const pies = CATALOGO.filter((s) => s.nombre.toLowerCase().includes('toalla de pie'));
    expect(pies).toHaveLength(1);
  });

  it('mantiene la facial más barata que la de mano en los tres gramajes', () => {
    for (const g of [680, 460, 360]) {
      const facial = buscarSku(`toalla-${g}-facial`)!;
      const mano = buscarSku(`toalla-${g}-mano`)!;
      expect(facial.precioLista).toBeLessThan(mano.precioLista);
    }
  });

  it('conserva precios de referencia del archivo', () => {
    expect(buscarSku('set-600-king')!.precioLista).toBe(90000);
    expect(buscarSku('inserto-de-duvet-king')!.precioLista).toBe(75000);
    expect(buscarSku('bata-blanca')!.precioLista).toBe(25000);
  });

  it('buscarSku devuelve undefined para un id inexistente', () => {
    expect(buscarSku('no-existe')).toBeUndefined();
  });
});

// --- Ronda de correcciones 1: fija los 70 nombres y los 70 precios ---
//
// Las pruebas de arriba solo fijan seis precios (tres correcciones + tres de
// referencia) y ningún nombre. Eso deja 64 precios y los 70 nombres sin
// ninguna red: un catálogo regenerado con un precio o un nombre cambiado a la
// mala (p. ej. "set de 600 hilos king" vuelto a "sábana king", o
// "set-400-queen" pasado de ₡60.000 a ₡6.000) sigue en verde.
//
// REFERENCIA es la fuente de verdad congelada al momento de esta ronda —el
// revisor reconstruyó los 70 precios contra los dos Excel y confirmó que
// coinciden—. Se usa `it.each` en vez de un solo `it` con un loop: así, si un
// solo id cambia, aparece UNA prueba roja con el id en el nombre, no un
// "algo cambió" genérico que obliga a comparar 70 líneas a ojo.
//
// Para actualizar esta tabla ante una lista de precios nueva y legítima: no
// se edita a mano. Se regenera el catálogo, se revisan los cambios con
// `git diff lib/cotizador/catalogo.ts`, y solo si son los esperados se
// regenera esta tabla desde el catálogo ya confirmado.
const REFERENCIA: Record<string, { nombre: string; precioLista: number }> = {
  'uni-filipina-tradicional-manga-corta': { nombre: 'Filipina tradicional manga corta', precioLista: 15500 },
  'uni-filipina-tradicional-corte-mujer-manga-corta': { nombre: 'Filipina tradicional corte mujer manga corta', precioLista: 15500 },
  'uni-filipina-ejecutiva-manga-corta-espalda-mesh': { nombre: 'Filipina ejecutiva manga corta espalda mesh', precioLista: 18500 },
  'uni-pantalon-de-cocina-tipo-baggy': { nombre: 'Pantalón de cocina tipo baggy', precioLista: 17500 },
  'uni-pantalon-de-cocina-tipo-baggy-corte-mujer': { nombre: 'Pantalón de cocina tipo baggy corte mujer', precioLista: 17500 },
  'uni-pantalon-tradicional-formal': { nombre: 'Pantalón tradicional formal', precioLista: 18000 },
  'uni-pantalon-tradicional-formal-corte-mujer': { nombre: 'Pantalón tradicional formal corte mujer', precioLista: 18000 },
  'uni-mandil-mediano': { nombre: 'Mandil mediano', precioLista: 9500 },
  'uni-mandil-largo': { nombre: 'Mandil largo', precioLista: 10500 },
  'uni-gorro-tipo-beanie-mesh-top': { nombre: 'Gorro tipo beanie mesh top', precioLista: 6500 },
  'uni-gabacha-ajustable': { nombre: 'Gabacha ajustable', precioLista: 7000 },
  'uni-mandil-corto': { nombre: 'Mandil corto', precioLista: 7000 },
  'uni-camisa-tipo-polo-warp-pique-tipo-lacoste': { nombre: 'Camisa tipo polo warp piqué (tipo Lacoste)', precioLista: 12000 },
  'uni-camisa-tipo-polo-warp-pique-corte-mujer': { nombre: 'Camisa tipo polo warp piqué corte mujer', precioLista: 12000 },
  'uni-camisa-tipo-polo-interlock-tipo-golf': { nombre: 'Camisa tipo polo interlock (tipo golf)', precioLista: 12000 },
  'uni-camisa-tipo-polo-interlock-corte-mujer': { nombre: 'Camisa tipo polo interlock corte mujer', precioLista: 12000 },
  'uni-camisa-tipo-columbia': { nombre: 'Camisa tipo Columbia', precioLista: 16500 },
  'uni-camisa-tipo-columbia-corte-mujer': { nombre: 'Camisa tipo Columbia corte mujer', precioLista: 16500 },
  'uni-camisa-de-servicio': { nombre: 'Camisa de servicio', precioLista: 17000 },
  'uni-camisa-de-servicio-corte-mujer': { nombre: 'Camisa de servicio corte mujer', precioLista: 17000 },
  'uni-camisa-formal-oxford-manga-corta': { nombre: 'Camisa formal Oxford manga corta', precioLista: 16000 },
  'uni-camisa-formal-oxford-manga-corta-corte-mujer': { nombre: 'Camisa formal Oxford manga corta corte mujer', precioLista: 16000 },
  'set-600-king': { nombre: 'Set de 600 hilos king', precioLista: 90000 },
  'set-600-queen': { nombre: 'Set de 600 hilos queen', precioLista: 85000 },
  'set-600-doble': { nombre: 'Set de 600 hilos doble', precioLista: 78000 },
  'set-600-imperial': { nombre: 'Set de 600 hilos imperial', precioLista: 70000 },
  'set-400-king': { nombre: 'Set de 400 hilos king', precioLista: 65000 },
  'set-400-queen': { nombre: 'Set de 400 hilos queen', precioLista: 60000 },
  'set-400-doble': { nombre: 'Set de 400 hilos doble', precioLista: 55000 },
  'set-400-imperial': { nombre: 'Set de 400 hilos imperial', precioLista: 50000 },
  'set-300-king': { nombre: 'Set de 300 hilos king', precioLista: 55000 },
  'set-300-queen': { nombre: 'Set de 300 hilos queen', precioLista: 50000 },
  'set-300-doble': { nombre: 'Set de 300 hilos doble', precioLista: 45000 },
  'set-300-imperial': { nombre: 'Set de 300 hilos imperial', precioLista: 40000 },
  'set-200-king': { nombre: 'Set de 200 hilos king', precioLista: 48000 },
  'set-200-queen': { nombre: 'Set de 200 hilos queen', precioLista: 40000 },
  'set-200-doble': { nombre: 'Set de 200 hilos doble', precioLista: 36000 },
  'set-200-imperial': { nombre: 'Set de 200 hilos imperial', precioLista: 31000 },
  'funda-king': { nombre: 'Funda de duvet 300 hilos king', precioLista: 55000 },
  'funda-queen': { nombre: 'Funda de duvet 300 hilos queen', precioLista: 50000 },
  'funda-doble': { nombre: 'Funda de duvet 300 hilos doble', precioLista: 45000 },
  'funda-imperial': { nombre: 'Funda de duvet 300 hilos imperial', precioLista: 40000 },
  'funda-de-duvet-rayada-king': { nombre: 'Funda de duvet rayada king', precioLista: 50000 },
  'funda-de-duvet-rayada-queen': { nombre: 'Funda de duvet rayada queen', precioLista: 45000 },
  'funda-de-duvet-rayada-doble': { nombre: 'Funda de duvet rayada doble', precioLista: 40000 },
  'funda-de-duvet-rayada-imperial': { nombre: 'Funda de duvet rayada imperial', precioLista: 35000 },
  'inserto-de-duvet-king': { nombre: 'Inserto de duvet king', precioLista: 75000 },
  'inserto-de-duvet-queen': { nombre: 'Inserto de duvet queen', precioLista: 68000 },
  'inserto-de-duvet-doble': { nombre: 'Inserto de duvet doble', precioLista: 60000 },
  'inserto-de-duvet-imperial': { nombre: 'Inserto de duvet imperial', precioLista: 55000 },
  'pillow-top-king': { nombre: 'Pillow top king', precioLista: 70000 },
  'pillow-top-queen': { nombre: 'Pillow top queen', precioLista: 65000 },
  'pillow-top-doble': { nombre: 'Pillow top doble', precioLista: 60000 },
  'pillow-top-imperial': { nombre: 'Pillow top imperial', precioLista: 53000 },
  'toalla-680-playa': { nombre: 'Toalla de playa 680 gm', precioLista: 12500 },
  'toalla-680-bano': { nombre: 'Toalla de baño 680 gm', precioLista: 10500 },
  'toalla-680-facial': { nombre: 'Toalla facial 680 gm', precioLista: 3000 },
  'toalla-680-mano': { nombre: 'Toalla de mano 680 gm', precioLista: 3500 },
  'toalla-460-playa': { nombre: 'Toalla de playa 460 gm', precioLista: 8000 },
  'toalla-460-bano': { nombre: 'Toalla de baño 460 gm', precioLista: 7500 },
  'toalla-460-facial': { nombre: 'Toalla facial 460 gm', precioLista: 2000 },
  'toalla-460-mano': { nombre: 'Toalla de mano 460 gm', precioLista: 2500 },
  'toalla-360-playa': { nombre: 'Toalla de playa 360 gm', precioLista: 6500 },
  'toalla-360-bano': { nombre: 'Toalla de baño 360 gm', precioLista: 6000 },
  'toalla-360-facial': { nombre: 'Toalla facial 360 gm', precioLista: 1800 },
  'toalla-360-mano': { nombre: 'Toalla de mano 360 gm', precioLista: 2000 },
  'toalla-de-pie': { nombre: 'Toalla de pie', precioLista: 5000 },
  'bata-blanca': { nombre: 'Bata blanca talla única', precioLista: 25000 },
  'almohada-king-2-unidades-por-paquete': { nombre: 'Almohada king (paquete de 2 unidades)', precioLista: 25000 },
  'almohada-queen-4-unidades-por-paquete': { nombre: 'Almohada queen (paquete de 4 unidades)', precioLista: 36000 },
};

describe('CATALOGO — tabla de referencia (nombre y precio de las 70 SKUs)', () => {
  it('la tabla de referencia cubre exactamente los ids del catálogo, ni de más ni de menos', () => {
    const idsReferencia = new Set(Object.keys(REFERENCIA));
    const idsCatalogo = new Set(CATALOGO.map((s) => s.id));
    expect(idsReferencia).toEqual(idsCatalogo);
  });

  it.each(Object.entries(REFERENCIA))('%s mantiene el nombre y el precio de referencia', (id, esperado) => {
    const sku = buscarSku(id);
    expect(sku, `falta el SKU "${id}" en el catálogo`).toBeDefined();
    expect(sku!.nombre, `nombre de "${id}"`).toBe(esperado.nombre);
    expect(sku!.precioLista, `precio de "${id}"`).toBe(esperado.precioLista);
  });
});
