import { describe, it, expect, vi } from 'vitest';
import { crearEstimate } from '@/lib/cotizador/ghl';
import type { Cotizacion } from '@/lib/cotizador/tipos';

const cotizacion: Cotizacion = {
  lineas: [
    {
      skuId: 'set-600-king', nombre: 'set de 600 hilos king',
      contenido: ['1 cubrecama', '1 sábana', '2 sobrefundas'],
      cantidad: 16, precioLista: 90000, descuentoPct: 10,
      precioUnitario: 81000, subtotal: 1296000, grupo: 'sets-cama',
      motivo: '16 sets en Sets de cama → 10%',
    },
  ],
  subtotal: 1296000, ahorro: 144000, tasaIva: 0.13, iva: 168480,
  total: 1464480, bordadoEspecial: false,
};

const params = {
  cotizacion,
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
  contactId: 'contacto-1',
};
const deps = { apiKey: 'llave', locationId: 'ubicacion' };

function respuesta(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('crearEstimate', () => {
  it('deja el descuento en cero y manda el IVA como línea aparte', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);

    // GoHighLevel recalcula: si le delegáramos el descuento o el IVA, el total
    // que ve el cliente no coincidiría con el que calculó nuestro motor.
    expect(cuerpo.discount).toEqual({ type: 'percentage', value: 0 });
    expect(cuerpo.items.some((i: { taxes?: unknown }) => i.taxes)).toBe(false);

    const iva = cuerpo.items[cuerpo.items.length - 1];
    expect(iva.name).toBe('IVA 13%');
    expect(iva.amount).toBe(168480);
    expect(iva.qty).toBe(1);
  });

  it('omite la línea de IVA cuando el cliente está exento', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    const exento = { ...cotizacion, tasaIva: 0, iva: 0, total: cotizacion.subtotal };
    await crearEstimate({ ...params, cotizacion: exento }, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.items).toHaveLength(1);
    expect(cuerpo.items[0].name).not.toMatch(/IVA/);
  });

  it('manda los campos que la API exige', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.title).toBeTruthy();
    expect(cuerpo.frequencySettings).toEqual({ enabled: false });
    expect(cuerpo.contactDetails.id).toBe('contacto-1');
    for (const item of cuerpo.items) expect(item.type).toBe('one_time');
  });

  it('da de alta el contacto cuando no llega uno', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ contact: { id: 'nuevo-1' } }))
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    const r = await crearEstimate({ ...params, contactId: undefined }, { ...deps, fetchImpl });

    expect(fetchImpl.mock.calls[0][0]).toContain('/contacts/upsert');
    const cuerpoEstimate = JSON.parse(fetchImpl.mock.calls[1][1].body);
    // Un id inventado crearía una cotización huérfana, sin contacto al que
    // hacerle seguimiento.
    expect(cuerpoEstimate.contactDetails.id).toBe('nuevo-1');
    expect(r).toEqual({ ok: true, estimateId: 'est-1', contactId: 'nuevo-1' });
  });

  it('no crea el estimate si falla el alta del contacto', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ message: 'duplicado' }, 400));
    const r = await crearEstimate({ ...params, contactId: undefined }, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('devuelve el id del estimate creado', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    const r = await crearEstimate(params, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, estimateId: 'est-1', contactId: 'contacto-1' });
  });

  it('manda los montos en colones enteros', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.currency).toBe('CRC');
    expect(cuerpo.items[0].amount).toBe(81000);
    expect(cuerpo.items[0].qty).toBe(16);
    expect(Number.isInteger(cuerpo.items[0].amount)).toBe(true);
  });

  it('nunca menciona método de pago', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = fetchImpl.mock.calls[0][1].body as string;
    expect(cuerpo).not.toMatch(/paymentMethod|pasarela|payNow/i);
    // `discount` sí aparece, pero en cero: se comprueba en su propia prueba.
  });

  it('desglosa el contenido del set en la descripción', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.items[0].description).toContain('1 cubrecama');
    expect(cuerpo.items[0].description).toContain('2 sobrefundas');
  });

  it('incluye la nota del bordado', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.termsNotes).toMatch(/10 ?x ?10/);
  });

  it('devuelve el error de GoHighLevel sin lanzar', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ message: 'no autorizado' }, 401));
    const r = await crearEstimate(params, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('401');
  });

  it('no lanza si se cae la red', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const r = await crearEstimate(params, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ECONNRESET');
  });

  it('un fallo de la Opportunity no invalida el estimate', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ message: 'pipeline no existe' }, 404));
    const r = await crearEstimate(params, { ...deps, fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.opportunityError).toContain('404');
  });
});
