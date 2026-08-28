import { describe, it, expect } from 'vitest';
import { renderizarCotizacion } from '@/lib/cotizador/documento';
import type { Cotizacion } from '@/lib/cotizador/tipos';

const cotizacion: Cotizacion = {
  lineas: [
    {
      skuId: 'set-600-king', nombre: 'Set de 600 hilos king',
      contenido: ['1 cubrecama', '1 sábana', '2 sobrefundas'],
      cantidad: 16, precioLista: 90000, descuentoPct: 10,
      precioUnitario: 81000, subtotal: 1296000, grupo: 'sets-cama',
      motivo: '16 sets en Sets de cama → 10%',
    },
  ],
  subtotal: 1296000, ahorro: 144000, tasaIva: 0.13, iva: 168480,
  total: 1464480, bordadoEspecial: false,
};

const base = {
  numero: 'COT-2026-0001',
  cotizacion,
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
  emitida: new Date('2026-08-27T12:00:00Z'),
  vence: new Date('2026-09-26T12:00:00Z'),
};

describe('renderizarCotizacion', () => {
  it('produce un PDF válido', async () => {
    const buf = await renderizarCotizacion(base);
    expect(Buffer.isBuffer(buf)).toBe(true);
    // Todo PDF empieza con esta firma. Sin ella no es un PDF, sea lo que sea.
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('no falla con una cotización de muchas líneas', async () => {
    const muchas = {
      ...base,
      cotizacion: {
        ...cotizacion,
        lineas: Array.from({ length: 40 }, (_, i) => ({
          ...cotizacion.lineas[0], skuId: `sku-${i}`, nombre: `Producto ${i}`,
        })),
      },
    };
    const buf = await renderizarCotizacion(muchas);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('no falla cuando el cliente está exento de IVA', async () => {
    const exento = {
      ...base,
      cotizacion: { ...cotizacion, tasaIva: 0, iva: 0, total: cotizacion.subtotal },
    };
    const buf = await renderizarCotizacion(exento);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('no falla sin empresa ni contenido de set', async () => {
    const minimo = {
      ...base,
      cliente: { nombre: 'Ana Pérez', email: 'ana@hotel.com' },
      cotizacion: {
        ...cotizacion,
        lineas: [{ ...cotizacion.lineas[0], contenido: undefined, descuentoPct: 0 }],
      },
    };
    const buf = await renderizarCotizacion(minimo);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
