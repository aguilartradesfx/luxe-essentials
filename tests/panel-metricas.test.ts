// tests/panel-metricas.test.ts
import { describe, it, expect } from 'vitest';
import { calcularMetricas } from '@/lib/cotizador/metricas';

const HOY = new Date('2026-08-27T12:00:00Z');

function fila(over: Record<string, unknown> = {}) {
  return {
    id: 'x', created_at: '2026-08-20T12:00:00Z', enviado_at: '2026-08-20T12:00:00Z',
    cerrada_at: null, estado: 'enviada', origen: 'humano',
    cliente: { nombre: 'Ana', empresa: 'Hotel' },
    lineas: [{ skuId: 'set-600-king', nombre: 'Set 600 king', cantidad: 16, subtotal: 1296000, grupo: 'sets-cama' }],
    totales: { subtotal: 1296000, ahorro: 144000, iva: 168480, total: 1464480 },
    ...over,
  } as never;
}

describe('calcularMetricas', () => {
  it('sin filas devuelve todo en cero', () => {
    const m = calcularMetricas([], HOY);
    expect(m.sinRespuesta.monto).toBe(0);
    expect(m.sinRespuesta.cotizaciones).toEqual([]);
    expect(m.ganado.monto).toBe(0);
  });

  it('cuenta lo enviado y sin cerrar como sin respuesta', () => {
    const m = calcularMetricas([fila(), fila({ id: 'y' })], HOY);
    expect(m.sinRespuesta.cantidad).toBe(2);
    expect(m.sinRespuesta.monto).toBe(1464480 * 2);
  });

  it('no cuenta como sin respuesta las ya cerradas', () => {
    const m = calcularMetricas([fila({ estado: 'ganada', cerrada_at: '2026-08-25T12:00:00Z' })], HOY);
    expect(m.sinRespuesta.cantidad).toBe(0);
  });

  it('marca las que vencen dentro de siete días', () => {
    // Enviada el 2026-07-30: vence a los 30 días, el 2026-08-29. Faltan 2 días.
    const m = calcularMetricas([fila({ enviado_at: '2026-07-30T12:00:00Z' })], HOY);
    expect(m.sinRespuesta.porVencer).toBe(1);
  });

  it('separa ganado de perdido', () => {
    const m = calcularMetricas([
      fila({ estado: 'ganada', cerrada_at: '2026-08-25T12:00:00Z' }),
      fila({ id: 'y', estado: 'perdida', cerrada_at: '2026-08-26T12:00:00Z' }),
    ], HOY);
    expect(m.ganado.cantidad).toBe(1);
    expect(m.ganado.monto).toBe(1464480);
    expect(m.perdido.cantidad).toBe(1);
  });

  it('calcula los días promedio entre enviar y cerrar', () => {
    const m = calcularMetricas([
      fila({ estado: 'ganada', enviado_at: '2026-08-01T12:00:00Z', cerrada_at: '2026-08-11T12:00:00Z' }),
    ], HOY);
    expect(m.ganado.diasPromedio).toBe(10);
  });

  it('suma el descuento otorgado y su promedio', () => {
    const m = calcularMetricas([fila(), fila({ id: 'y' })], HOY);
    expect(m.descuento.monto).toBe(144000 * 2);
    // 144.000 sobre un bruto de 1.440.000 es 10%.
    expect(m.descuento.promedioPct).toBeCloseTo(10, 1);
  });

  it('cuenta los productos más cotizados en unidades y en dinero', () => {
    const m = calcularMetricas([fila(), fila({ id: 'y' })], HOY);
    expect(m.productos[0]).toMatchObject({ nombre: 'Set 600 king', unidades: 32, monto: 2592000 });
  });

  it('reparte entre uniformes y hogar por el grupo de cada línea', () => {
    const m = calcularMetricas([
      fila(),
      fila({ id: 'y', lineas: [{ skuId: 'uni-a', nombre: 'Filipina', cantidad: 10, subtotal: 100000, grupo: 'uniformes' }] }),
    ], HOY);
    expect(m.porLinea.hogar.monto).toBe(1296000);
    expect(m.porLinea.uniformes.monto).toBe(100000);
  });

  it('cuenta las fallidas aparte', () => {
    const m = calcularMetricas([fila({ estado: 'error' })], HOY);
    expect(m.fallidas).toBe(1);
    expect(m.sinRespuesta.cantidad).toBe(0);
  });

  it('separa las que nacieron del agente', () => {
    const m = calcularMetricas([fila(), fila({ id: 'y', origen: 'agente' })], HOY);
    expect(m.porOrigen).toEqual({ humano: 1, agente: 1 });
  });

  it('devuelve montos enteros', () => {
    const m = calcularMetricas([fila(), fila({ id: 'y' })], HOY);
    for (const v of [m.sinRespuesta.monto, m.ganado.monto, m.descuento.monto]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });
  it('cuenta las fallidas en productos, reparto y origen, pero no en el descuento', () => {
    const m = calcularMetricas([fila({ estado: 'error', origen: 'agente' })], HOY);
    expect(m.productos[0]).toMatchObject({ nombre: 'Set 600 king', unidades: 16, monto: 1296000 });
    expect(m.porLinea.hogar.monto).toBe(1296000);
    expect(m.porOrigen).toEqual({ agente: 1 });
    expect(m.descuento.monto).toBe(0);
  });

  it('excluye borrador y convertida de todas las metricas de dinero y producto', () => {
    const filas = [
      fila({ id: '1', estado: 'creada', cerrada_at: null }),
      fila({ id: '2', estado: 'enviada', cerrada_at: null }),
      fila({ id: '3', estado: 'error', cerrada_at: null }),
      fila({ id: '4', estado: 'ganada', cerrada_at: '2026-08-25T12:00:00Z' }),
      fila({ id: '5', estado: 'perdida', cerrada_at: '2026-08-26T12:00:00Z' }),
      fila({ id: '6', estado: 'borrador', enviado_at: null, cerrada_at: null, lineas: [], totales: {} }),
      fila({ id: '7', estado: 'convertida', enviado_at: null, cerrada_at: null, lineas: [], totales: {} }),
    ];
    const m = calcularMetricas(filas, HOY);
    expect(m.sinRespuesta.cantidad).toBe(2);
    expect(m.ganado.cantidad).toBe(1);
    expect(m.perdido.cantidad).toBe(1);
    expect(m.fallidas).toBe(1);
    // Las 5 filas reales aportan a origen; borrador y convertida no cuentan.
    expect(m.porOrigen).toEqual({ humano: 5 });
    // 5 filas reales x 16 unidades del mismo SKU.
    expect(m.productos[0]).toMatchObject({ nombre: 'Set 600 king', unidades: 80, monto: 5 * 1296000 });
  });

  it('no cuenta dos veces cuando un borrador se convierte en cotizacion real', () => {
    const original = fila({ id: 'draft', estado: 'convertida', enviado_at: null, cerrada_at: null, lineas: [], totales: {} });
    const nueva = fila({ id: 'real', estado: 'enviada' });
    const m = calcularMetricas([original, nueva], HOY);
    expect(m.sinRespuesta.cantidad).toBe(1);
    expect(m.sinRespuesta.monto).toBe(1464480);
  });

  it('marca por vencer solo entre 0 y 7 dias, y vencidas aparte', () => {
    const casos = [
      { id: 'a', enviado_at: '2026-08-04T12:00:00Z' }, // vence en 7 dias exactos -> porVencer
      { id: 'b', enviado_at: '2026-08-05T12:00:00Z' }, // vence en 8 dias -> ninguno de los dos
      { id: 'c', enviado_at: '2026-07-28T12:00:00Z' }, // vence hoy (0 dias) -> porVencer
      { id: 'd', enviado_at: '2026-07-27T12:00:00Z' }, // vencio ayer (-1 dia) -> vencidas
      { id: 'e', enviado_at: '2026-05-29T12:00:00Z' }, // vencio hace mucho -> vencidas
    ];
    const m = calcularMetricas(casos.map((c) => fila(c)), HOY);
    expect(m.sinRespuesta.porVencer).toBe(2); // a y c
    expect(m.sinRespuesta.vencidas).toBe(2); // d y e
  });

  it('promedia los dias entre enviar y cerrar redondeando una sola vez', () => {
    const m = calcularMetricas([
      fila({ id: '1', estado: 'ganada', enviado_at: '2026-08-01T00:00:00Z', cerrada_at: '2026-08-01T09:36:00Z' }), // 0.4 dias
      fila({ id: '2', estado: 'ganada', enviado_at: '2026-08-01T00:00:00Z', cerrada_at: '2026-08-02T09:36:00Z' }), // 1.4 dias
      fila({ id: '3', estado: 'ganada', enviado_at: '2026-08-01T00:00:00Z', cerrada_at: '2026-08-01T09:36:00Z' }), // 0.4 dias
    ], HOY);
    // Promedio real: (0.4+1.4+0.4)/3 = 0.7333 -> redondeado una vez da 1.
    // Redondear por fila primero (0+1+0)/3=0.333 daria 0, que es el bug.
    expect(m.ganado.diasPromedio).toBe(1);
  });
});
