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

  // --- Ronda de correcciones 1 ---

  it('la suma de todas las líneas más el IVA coincide con el total de la cotización', async () => {
    // Mutante que esto mata: descartar todas las líneas menos la primera. Con
    // una sola línea de fixture ese mutante pasaba 27/27; con dos líneas más
    // el IVA, la suma deja de cuadrar contra el total si falta un renglón.
    const dosLineas: Cotizacion = {
      lineas: [
        {
          skuId: 'linea-a', nombre: 'Línea A', cantidad: 3, precioLista: 10000,
          descuentoPct: 0, precioUnitario: 10000, subtotal: 30000, grupo: 'uniformes',
          motivo: 'sin descuento',
        },
        {
          skuId: 'linea-b', nombre: 'Línea B', cantidad: 5, precioLista: 20000,
          descuentoPct: 5, precioUnitario: 19000, subtotal: 95000, grupo: 'toallas',
          motivo: '5%',
        },
      ],
      subtotal: 125000, ahorro: 5000, tasaIva: 0.13, iva: 16250, total: 141250,
      bordadoEspecial: false,
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate({ ...params, cotizacion: dosLineas }, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);

    expect(cuerpo.items).toHaveLength(3); // 2 líneas de producto + 1 de IVA
    const suma = (cuerpo.items as Array<{ amount: number; qty: number }>).reduce(
      (acc, item) => acc + item.amount * item.qty,
      0,
    );
    expect(suma).toBe(dosLineas.total);
  });

  it('incluye altId y altType, obligatorios para la API', async () => {
    // Mutante que esto mata: borrar cualquiera de los dos campos del cuerpo.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.altId).toBe('ubicacion');
    expect(cuerpo.altType).toBe('location');
  });

  it('manda liveMode explícito en true', async () => {
    // Sondeado contra la API real: si se omite, GHL lo pone en `true` por su
    // cuenta. Se manda explícito para no depender de un default implícito.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.liveMode).toBe(true);
  });

  it('manda issueDate y expiryDate con 30 días de vigencia', async () => {
    // Sondeado contra la API real: ambos son obligatorios (422 si se omiten).
    // Y aunque no lo fueran, una cotización sin fecha de vencimiento es un
    // precio que el cliente podría reclamar como vigente para siempre.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cuerpo.expiryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const emision = new Date(`${cuerpo.issueDate}T00:00:00Z`);
    const vencimiento = new Date(`${cuerpo.expiryDate}T00:00:00Z`);
    const dias = Math.round((vencimiento.getTime() - emision.getTime()) / (1000 * 60 * 60 * 24));
    expect(dias).toBe(30);
  });

  it('etiqueta correctamente una tasa de IVA fraccionaria (no redondea el rótulo)', async () => {
    // Mutante que esto mata: `(tasa*100).toFixed(0)`, que da "IVA 3%" para
    // 2.5% — el dinero está bien, pero el rótulo miente.
    const fraccionaria = { ...cotizacion, tasaIva: 0.025, iva: 32400, total: cotizacion.subtotal + 32400 };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate({ ...params, cotizacion: fraccionaria }, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const iva = cuerpo.items[cuerpo.items.length - 1];
    expect(iva.name).toBe('IVA 2.5%');
  });

  it('mueve la oportunidad por pipelineStageId, no por nombre', async () => {
    // La API real rechaza `pipelineStageName` con 422 ("property
    // pipelineStageName should not exist"): el DTO usa whitelist estricta y
    // la etapa se identifica solo por id. Sondeado en la ronda 1
    // (docs/ghl-estimate-payload.md).
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuesta({ id: 'opp-1' }));
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpoOportunidad = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(cuerpoOportunidad.pipelineStageId).toBeTruthy();
    expect(cuerpoOportunidad).not.toHaveProperty('pipelineStageName');
  });

  it('conserva el contactId recibido aunque el estimate falle', async () => {
    // Antes de esta corrección, un fallo del Estimate perdía el contactId por
    // completo, incluso cuando ya se sabía cuál era (recibido o recién
    // creado). Eso deja contactos sin cotización asociada y sin rastro.
    const fetchImpl = vi.fn().mockResolvedValueOnce(respuesta({ message: 'boom' }, 500));
    const r = await crearEstimate(params, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.contactId).toBe('contacto-1');
  });

  it('conserva el contactId del contacto recién creado aunque el estimate falle después', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ contact: { id: 'nuevo-2' } }))
      .mockResolvedValueOnce(respuesta({ message: 'boom' }, 500));
    const r = await crearEstimate({ ...params, contactId: undefined }, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.contactId).toBe('nuevo-2');
  });

  it('no manda contactId cuando ni siquiera se pudo resolver el contacto', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ message: 'duplicado' }, 400));
    const r = await crearEstimate({ ...params, contactId: undefined }, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.contactId).toBeUndefined();
  });
});
