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
});
