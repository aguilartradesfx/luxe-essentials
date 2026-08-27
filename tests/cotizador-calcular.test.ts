import { describe, it, expect } from 'vitest';
import { calcular } from '@/lib/cotizador/calcular';
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
    expect(c.iva).toBe(Math.round(9500 * 24 * 0.13));
    expect(c.total).toBe(c.subtotal + c.iva);
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

  it('marca el bordado especial cuando se pide', () => {
    const c = calcular([{ skuId: 'uni-a', cantidad: 1 }], SKUS, { bordadoEspecial: true });
    expect(c.bordadoEspecial).toBe(true);
  });

  it('lanza si un sku no existe en el catálogo', () => {
    expect(() => calcular([{ skuId: 'fantasma', cantidad: 1 }], SKUS)).toThrow(/fantasma/);
  });

  it('lanza si la cantidad no es un entero positivo', () => {
    expect(() => calcular([{ skuId: 'uni-a', cantidad: 0 }], SKUS)).toThrow(/cantidad/i);
    expect(() => calcular([{ skuId: 'uni-a', cantidad: 1.5 }], SKUS)).toThrow(/cantidad/i);
    expect(() => calcular([{ skuId: 'uni-a', cantidad: -3 }], SKUS)).toThrow(/cantidad/i);
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
