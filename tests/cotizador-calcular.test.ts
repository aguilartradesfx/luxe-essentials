import { describe, it, expect } from 'vitest';
import { calcular } from '@/lib/cotizador/calcular';
import { IVA_GENERAL } from '@/lib/cotizador/escalas';
import type { Sku } from '@/lib/cotizador/tipos';

// Catálogo de prueba: no depende de los precios reales de Luxe, para que un
// cambio de lista no rompa las pruebas del motor.
const SKUS: Sku[] = [
  { id: 'uni-a', linea: 'uniformes', grupo: 'uniformes', familia: 'Filipinas', nombre: 'Filipina A', precioLista: 10000 },
  { id: 'uni-b', linea: 'uniformes', grupo: 'uniformes', familia: 'Pantalones', nombre: 'Pantalón B', precioLista: 20000 },
  { id: 'set-k', linea: 'hogar', grupo: 'sets-cama', familia: 'Sets 600', nombre: 'Set 600 king', talla: 'king', precioLista: 90000, contenido: ['1 cubrecama', '1 sábana', '2 sobrefundas'] },
  { id: 'set-q', linea: 'hogar', grupo: 'sets-cama', familia: 'Sets 600', nombre: 'Set 600 queen', talla: 'queen', precioLista: 85000 },
  { id: 'set-d', linea: 'hogar', grupo: 'sets-cama', familia: 'Sets 600', nombre: 'Set 600 doble', talla: 'doble', precioLista: 78000 },
  { id: 'toa-a', linea: 'hogar', grupo: 'toallas', familia: 'Toallas 680', nombre: 'Toalla de baño', precioLista: 10500 },
  { id: 'bata', linea: 'hogar', grupo: 'bata', familia: 'Toallas', nombre: 'Bata blanca', precioLista: 25000 },
  { id: 'impar', linea: 'uniformes', grupo: 'uniformes', familia: 'Prueba', nombre: 'Precio impar', precioLista: 15550 },
];

describe('calcular', () => {
  it('sin líneas devuelve una cotización en cero', () => {
    const c = calcular([], SKUS);
    expect(c.lineas).toEqual([]);
    expect(c.subtotal).toBe(0);
    expect(c.iva).toBe(0);
    expect(c.total).toBe(0);
  });

  it('no descuenta por debajo del umbral', () => {
    const c = calcular([{ skuId: 'uni-a', cantidad: 23 }], SKUS);
    expect(c.lineas[0].descuentoPct).toBe(0);
    expect(c.lineas[0].precioUnitario).toBe(10000);
    expect(c.subtotal).toBe(230000);
    expect(c.ahorro).toBe(0);
  });

  it('acumula cantidades entre productos del mismo grupo', () => {
    // El ejemplo textual de Luxe: 10 + 30 + 8 = 48 prendas -> 10%,
    // aunque ninguna línea llegue por su cuenta a 24.
    const c = calcular(
      [
        { skuId: 'uni-a', cantidad: 30 },
        { skuId: 'uni-b', cantidad: 10 },
        { skuId: 'impar', cantidad: 8 },
      ],
      SKUS,
    );
    for (const linea of c.lineas) expect(linea.descuentoPct).toBe(10);
    // No basta con auditar el porcentaje: un motor que solo sumara la
    // primera línea al subtotal pasaría el `for` de arriba sin que nada
    // fallara. Los números son a mano:
    //   uni-a: 10000*0.9=9000 * 30 = 270000
    //   uni-b: 20000*0.9=18000 * 10 = 180000
    //   impar: 15550*0.9=13995 * 8  = 111960
    //   subtotal = 270000+180000+111960 = 561960
    //   bruto    = 10000*30+20000*10+15550*8 = 624400
    //   ahorro   = 624400-561960 = 62440
    //   iva (13%) = round(561960*0.13) = round(73054.8) = 73055
    //   total     = 561960+73055 = 635015
    expect(c.subtotal).toBe(561960);
    expect(c.ahorro).toBe(62440);
    expect(c.iva).toBe(73055);
    expect(c.total).toBe(635015);
  });

  it('reproduce el ejemplo de sets que dio Luxe', () => {
    // 10 king + 3 queen + 3 doble = 16 sets -> 10%
    const c = calcular(
      [
        { skuId: 'set-k', cantidad: 10 },
        { skuId: 'set-q', cantidad: 3 },
        { skuId: 'set-d', cantidad: 3 },
      ],
      SKUS,
    );
    for (const linea of c.lineas) expect(linea.descuentoPct).toBe(10);
    expect(c.lineas[0].precioUnitario).toBe(81000);
    // A mano: 10*81000 + 3*76500 + 3*70200 = 810000+229500+210600 = 1.250.100.
    // Este es el caso que la ronda anterior desperdició: verificaba el
    // porcentaje de cada línea pero nunca el subtotal agregado, así que un
    // motor que solo sumara la primera línea (81000*10=810000, ignorando el
    // resto) pasaba igual.
    expect(c.subtotal).toBe(1250100);
    // bruto = 10*90000+3*85000+3*78000 = 1.389.000; ahorro = 138.900.
    expect(c.ahorro).toBe(138900);
  });

  it('no mezcla grupos: la bata no acumula con las toallas', () => {
    const c = calcular(
      [
        { skuId: 'toa-a', cantidad: 23 },
        { skuId: 'bata', cantidad: 1 },
      ],
      SKUS,
    );
    // 23 + 1 = 24 sería 5% si acumularan. No acumulan.
    expect(c.lineas.find((l) => l.skuId === 'toa-a')!.descuentoPct).toBe(0);
    expect(c.lineas.find((l) => l.skuId === 'bata')!.descuentoPct).toBe(0);
  });

  it('aplica escalas distintas a grupos distintos en la misma cotización', () => {
    const c = calcular(
      [
        { skuId: 'uni-a', cantidad: 24 },
        { skuId: 'set-k', cantidad: 16 },
      ],
      SKUS,
    );
    expect(c.lineas.find((l) => l.skuId === 'uni-a')!.descuentoPct).toBe(5);
    expect(c.lineas.find((l) => l.skuId === 'set-k')!.descuentoPct).toBe(10);
  });

  it('redondea el precio unitario y el subtotal es unitario por cantidad', () => {
    // 15550 * 0.95 = 14772,5 -> 14773 (medio hacia arriba)
    const c = calcular([{ skuId: 'impar', cantidad: 24 }], SKUS);
    expect(c.lineas[0].precioUnitario).toBe(14773);
    expect(c.lineas[0].subtotal).toBe(14773 * 24);
    expect(Number.isInteger(c.subtotal)).toBe(true);
  });

  it('calcula el IVA sobre el subtotal ya descontado', () => {
    const c = calcular([{ skuId: 'uni-a', cantidad: 24 }], SKUS);
    expect(c.subtotal).toBe(9500 * 24);
    // Literal, no `Math.round(9500 * 24 * 0.13)`: repetir la fórmula de la
    // implementación en la expectativa nunca puede fallar. 228000*0.13=29640
    // exacto (a mano), y el default se ancla a IVA_GENERAL para que el
    // valor no se desacople de `lib/cotizador/escalas.ts`.
    expect(c.tasaIva).toBe(IVA_GENERAL);
    expect(c.iva).toBe(29640);
    expect(c.total).toBe(c.subtotal + c.iva);
  });

  it('usa IVA_GENERAL como tasa por defecto, no un literal repetido', () => {
    const c = calcular([{ skuId: 'uni-a', cantidad: 1 }], SKUS);
    expect(c.tasaIva).toBe(IVA_GENERAL);
  });

  it('redondea el IVA medio hacia arriba cuando cae justo en ,5', () => {
    // impar (15550) x13, sin descuento (13 < 24): subtotal = 202150.
    // 202150 * 0.13 = 26279,5 exacto -> medio hacia arriba = 26280.
    // Los mutantes `floor`/`trunc` del redondeo darían 26279 y esta prueba
    // los mata; el valor esperado es literal, no la misma fórmula del código.
    const c = calcular([{ skuId: 'impar', cantidad: 13 }], SKUS);
    expect(c.subtotal).toBe(202150);
    expect(c.iva).toBe(26280);
    expect(c.total).toBe(228430);
  });

  it('redondea el IVA hacia abajo cuando la fracción es menor a ,5', () => {
    // uni-a x7 sin descuento: subtotal = 70000. Con tasaIva = 0.06789,
    // 70000 * 0.06789 = 4752,3 -> medio hacia arriba = 4752 (se queda).
    // El mutante `ceil` daría 4753; esta prueba lo mata, y el caso anterior
    // (,5) no lo hacía porque a ,5 tanto `ceil` como el redondeo correcto
    // coinciden.
    const c = calcular([{ skuId: 'uni-a', cantidad: 7 }], SKUS, { tasaIva: 0.06789 });
    expect(c.subtotal).toBe(70000);
    expect(c.iva).toBe(4752);
  });

  it('acepta una tasa de IVA distinta de la general', () => {
    const c = calcular([{ skuId: 'uni-a', cantidad: 10 }], SKUS, { tasaIva: 0.01 });
    expect(c.tasaIva).toBe(0.01);
    expect(c.iva).toBe(Math.round(100000 * 0.01));
  });

  it('con tasa cero no suma IVA', () => {
    const c = calcular([{ skuId: 'uni-a', cantidad: 10 }], SKUS, { tasaIva: 0 });
    expect(c.iva).toBe(0);
    expect(c.total).toBe(c.subtotal);
  });

  it('lanza si la tasa de IVA no es un número finito entre 0 y 1', () => {
    // La Tarea 8 llama a `calcular` directo desde el estado de React sin
    // Zod: un campo vacío da `parseFloat('') === NaN` y sin esta validación
    // el vendedor vería "NaN" en la pantalla, en silencio.
    expect(() =>
      calcular([{ skuId: 'uni-a', cantidad: 1 }], SKUS, { tasaIva: NaN }),
    ).toThrow(/tasa/i);
    expect(() =>
      calcular([{ skuId: 'uni-a', cantidad: 1 }], SKUS, { tasaIva: -0.1 }),
    ).toThrow(/tasa/i);
    expect(() =>
      calcular([{ skuId: 'uni-a', cantidad: 1 }], SKUS, { tasaIva: 1.5 }),
    ).toThrow(/tasa/i);
  });

  it('reporta el ahorro frente al precio de lista', () => {
    const c = calcular([{ skuId: 'uni-a', cantidad: 24 }], SKUS);
    expect(c.ahorro).toBe(10000 * 24 - 9500 * 24);
  });

  it('explica por qué se aplicó cada descuento', () => {
    const c = calcular([{ skuId: 'uni-a', cantidad: 48 }], SKUS);
    expect(c.lineas[0].motivo).toBe('48 prendas en Uniformes → 10%');
  });

  it('arrastra el contenido del set para imprimirlo', () => {
    const c = calcular([{ skuId: 'set-k', cantidad: 1 }], SKUS);
    expect(c.lineas[0].contenido).toEqual(['1 cubrecama', '1 sábana', '2 sobrefundas']);
  });

  it('no comparte referencia de contenido con el catálogo', () => {
    // `calcular` se anuncia pura. Si devolviera el arreglo del catálogo por
    // referencia, un `push` sobre el resultado contaminaría el SKU
    // original, y en Next.js el catálogo vive en memoria durante todo el
    // proceso: la contaminación cruzaría peticiones de distintos clientes.
    const skuSetK = SKUS.find((s) => s.id === 'set-k')!;
    const c = calcular([{ skuId: 'set-k', cantidad: 1 }], SKUS);
    expect(c.lineas[0].contenido).not.toBe(skuSetK.contenido);
    c.lineas[0].contenido!.push('contaminación');
    expect(skuSetK.contenido).not.toContain('contaminación');
  });

  it('marca el bordado especial cuando se pide', () => {
    const c = calcular([{ skuId: 'uni-a', cantidad: 1 }], SKUS, { bordadoEspecial: true });
    expect(c.bordadoEspecial).toBe(true);
  });

  it('el bordado especial es false por defecto', () => {
    // Un default invertido convertiría toda cotización en "cotizar aparte"
    // sin que nada se pusiera rojo.
    const c = calcular([{ skuId: 'uni-a', cantidad: 1 }], SKUS);
    expect(c.bordadoEspecial).toBe(false);
  });

  it('lanza si un sku no existe en el catálogo', () => {
    expect(() => calcular([{ skuId: 'fantasma', cantidad: 1 }], SKUS)).toThrow(/fantasma/);
  });

  it('lanza si la cantidad no es un entero positivo', () => {
    expect(() => calcular([{ skuId: 'uni-a', cantidad: 0 }], SKUS)).toThrow(/cantidad/i);
    expect(() => calcular([{ skuId: 'uni-a', cantidad: 1.5 }], SKUS)).toThrow(/cantidad/i);
    expect(() => calcular([{ skuId: 'uni-a', cantidad: -3 }], SKUS)).toThrow(/cantidad/i);
  });

  it('lanza si el precio de lista del sku es negativo', () => {
    const skusConPrecioNegativo: Sku[] = [
      ...SKUS,
      {
        id: 'malo',
        linea: 'uniformes',
        grupo: 'uniformes',
        familia: 'Prueba',
        nombre: 'Precio negativo',
        precioLista: -1000,
      },
    ];
    expect(() =>
      calcular([{ skuId: 'malo', cantidad: 1 }], skusConPrecioNegativo),
    ).toThrow(/precio/i);
  });

  it('suma las cantidades cuando el mismo sku aparece dos veces', () => {
    const c = calcular(
      [
        { skuId: 'uni-a', cantidad: 12 },
        { skuId: 'uni-a', cantidad: 12 },
      ],
      SKUS,
    );
    expect(c.lineas).toHaveLength(1);
    expect(c.lineas[0].cantidad).toBe(24);
    expect(c.lineas[0].descuentoPct).toBe(5);
  });
});
