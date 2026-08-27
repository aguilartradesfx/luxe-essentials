import { describe, it, expect, vi } from 'vitest';
import { crearEstimate, ETAPA_CALIFICADA_ID, ETAPA_PROPUESTA_ID } from '@/lib/cotizador/ghl';
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

// La respuesta real de `POST /opportunities/` trae la etapa que quedó
// guardada. La mayoría de las pruebas de este archivo no están probando C3
// (la detección de una etapa equivocada), así que usan esta variante "sana"
// por defecto: coincide con lo que `crearEstimate` pide HOY — "Qualified",
// no "Proposal Sent" (ronda de correcciones 2, hallazgo C1: ver el
// comentario de `ETAPA_CALIFICADA_ID` en lib/cotizador/ghl.ts).
function respuestaOportunidad(pipelineStageId: string | undefined = ETAPA_CALIFICADA_ID) {
  return respuesta({ id: 'opp-1', pipelineStageId });
}

// `resolverContacto` ya no manda firstName/tags/source en el upsert inicial
// (ver C2): sólo identifica o crea el contacto. El enriquecimiento
// no-destructivo pasa por un GET + PUT aparte contra `lib/ghl-contacto.ts`.
// Estas dos respuestas son ese GET y ese PUT, en ese orden.
function respuestasEnriquecimiento(contactoActual: Record<string, unknown> = {}) {
  return [respuesta({ contact: contactoActual }), respuesta({})];
}

// Ronda "final-fix-C": `resolverContacto` ahora enriquece el contacto
// también cuando `contactId` ya viene resuelto (el caso de `params` de acá
// abajo, y del flujo real del borrador del agente) — antes solo lo hacía
// para un contacto recién dado de alta. Toda prueba de este archivo que use
// `params` tal cual (sin `contactId: undefined`) dispara ese GET+PUT antes
// de la secuencia que le interese probar; este helper los antepone para no
// repetir el mismo bloque de tres líneas en cada `it`.
function fetchConContactoConocido(...secuencia: unknown[]) {
  const fetchImpl = vi.fn();
  const [get, put] = respuestasEnriquecimiento();
  fetchImpl.mockResolvedValueOnce(get).mockResolvedValueOnce(put);
  for (const r of secuencia) fetchImpl.mockResolvedValueOnce(r);
  return fetchImpl;
}

describe('crearEstimate', () => {
  it('deja el descuento en cero y manda el IVA como línea aparte', async () => {
    const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[2][1].body);

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
    const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
    const exento = { ...cotizacion, tasaIva: 0, iva: 0, total: cotizacion.subtotal };
    await crearEstimate({ ...params, cotizacion: exento }, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[2][1].body);
    expect(cuerpo.items).toHaveLength(1);
    expect(cuerpo.items[0].name).not.toMatch(/IVA/);
  });

  it('manda los campos que la API exige', async () => {
    const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[2][1].body);
    expect(cuerpo.title).toBeTruthy();
    expect(cuerpo.frequencySettings).toEqual({ enabled: false });
    expect(cuerpo.contactDetails.id).toBe('contacto-1');
    for (const item of cuerpo.items) expect(item.type).toBe('one_time');
  });

  it('da de alta el contacto cuando no llega uno', async () => {
    const [get, put] = respuestasEnriquecimiento();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ contact: { id: 'nuevo-1' } })) // upsert (identifica/crea)
      .mockResolvedValueOnce(get)                                       // GET del enriquecimiento
      .mockResolvedValueOnce(put)                                       // PUT del enriquecimiento
      .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
      .mockResolvedValueOnce(respuestaOportunidad());
    const r = await crearEstimate({ ...params, contactId: undefined }, { ...deps, fetchImpl });

    expect(fetchImpl.mock.calls[0][0]).toContain('/contacts/upsert');
    const cuerpoEstimate = JSON.parse(fetchImpl.mock.calls[3][1].body);
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
    const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
    const r = await crearEstimate(params, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, estimateId: 'est-1', contactId: 'contacto-1' });
  });

  it('manda los montos en colones enteros', async () => {
    const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[2][1].body);
    expect(cuerpo.currency).toBe('CRC');
    expect(cuerpo.items[0].amount).toBe(81000);
    expect(cuerpo.items[0].qty).toBe(16);
    expect(Number.isInteger(cuerpo.items[0].amount)).toBe(true);
  });

  it('nunca menciona método de pago', async () => {
    const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = fetchImpl.mock.calls[2][1].body as string;
    expect(cuerpo).not.toMatch(/paymentMethod|pasarela|payNow/i);
    // `discount` sí aparece, pero en cero: se comprueba en su propia prueba.
  });

  it('desglosa el contenido del set en la descripción', async () => {
    const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[2][1].body);
    expect(cuerpo.items[0].description).toContain('1 cubrecama');
    expect(cuerpo.items[0].description).toContain('2 sobrefundas');
  });

  it('incluye la nota del bordado', async () => {
    const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[2][1].body);
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
    const fetchImpl = fetchConContactoConocido(
      respuesta({ _id: 'est-1' }),
      respuesta({ message: 'pipeline no existe' }, 404),
    );
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
    const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
    await crearEstimate({ ...params, cotizacion: dosLineas }, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[2][1].body);

    expect(cuerpo.items).toHaveLength(3); // 2 líneas de producto + 1 de IVA
    const suma = (cuerpo.items as Array<{ amount: number; qty: number }>).reduce(
      (acc, item) => acc + item.amount * item.qty,
      0,
    );
    expect(suma).toBe(dosLineas.total);
  });

  it('incluye altId y altType, obligatorios para la API', async () => {
    // Mutante que esto mata: borrar cualquiera de los dos campos del cuerpo.
    const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[2][1].body);
    expect(cuerpo.altId).toBe('ubicacion');
    expect(cuerpo.altType).toBe('location');
  });

  it('manda liveMode explícito en true', async () => {
    // Sondeado contra la API real: si se omite, GHL lo pone en `true` por su
    // cuenta. Se manda explícito para no depender de un default implícito.
    const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[2][1].body);
    expect(cuerpo.liveMode).toBe(true);
  });

  it('manda issueDate y expiryDate con 30 días de vigencia', async () => {
    // Sondeado contra la API real: ambos son obligatorios (422 si se omiten).
    // Y aunque no lo fueran, una cotización sin fecha de vencimiento es un
    // precio que el cliente podría reclamar como vigente para siempre.
    const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[2][1].body);
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
    const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
    await crearEstimate({ ...params, cotizacion: fraccionaria }, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[2][1].body);
    const iva = cuerpo.items[cuerpo.items.length - 1];
    expect(iva.name).toBe('IVA 2.5%');
  });

  it('mueve la oportunidad por pipelineStageId, no por nombre', async () => {
    // La API real rechaza `pipelineStageName` con 422 ("property
    // pipelineStageName should not exist"): el DTO usa whitelist estricta y
    // la etapa se identifica solo por id. Sondeado en la ronda 1
    // (docs/ghl-estimate-payload.md).
    const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
    await crearEstimate(params, { ...deps, fetchImpl });
    const cuerpoOportunidad = JSON.parse(fetchImpl.mock.calls[3][1].body);
    expect(cuerpoOportunidad.pipelineStageId).toBeTruthy();
    expect(cuerpoOportunidad).not.toHaveProperty('pipelineStageName');
  });

  it('conserva el contactId recibido aunque el estimate falle', async () => {
    // Antes de esta corrección, un fallo del Estimate perdía el contactId por
    // completo, incluso cuando ya se sabía cuál era (recibido o recién
    // creado). Eso deja contactos sin cotización asociada y sin rastro.
    const fetchImpl = fetchConContactoConocido(respuesta({ message: 'boom' }, 500));
    const r = await crearEstimate(params, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.contactId).toBe('contacto-1');
  });

  it('conserva el contactId del contacto recién creado aunque el estimate falle después', async () => {
    const [get, put] = respuestasEnriquecimiento();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respuesta({ contact: { id: 'nuevo-2' } }))
      .mockResolvedValueOnce(get)
      .mockResolvedValueOnce(put)
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

  // --- Ronda de correcciones 2 (hallazgos C2 y C3 de la revisión final) ---

  describe('C2 — no pisa un contacto existente de la base importada', () => {
    it('el upsert inicial sólo manda locationId y email: nada de firstName, tags ni source', async () => {
      // Mutante que esto mata: volver a mandar firstName/tags/source en el
      // upsert, que es justo lo que borraba la segmentación comercial del
      // contacto (hallazgo C2). Verificado contra la API real que un upsert
      // sin estos campos no los vacía (docs/ghl-estimate-payload.md, "Ronda
      // de correcciones 2").
      const [get, put] = respuestasEnriquecimiento();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(respuesta({ contact: { id: 'nuevo-3' } }))
        .mockResolvedValueOnce(get)
        .mockResolvedValueOnce(put)
        .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
        .mockResolvedValueOnce(respuestaOportunidad());
      await crearEstimate({ ...params, contactId: undefined }, { ...deps, fetchImpl });

      const cuerpoUpsert = JSON.parse(fetchImpl.mock.calls[0][1].body);
      expect(cuerpoUpsert).toEqual({ locationId: 'ubicacion', email: 'ana@hotel.com' });
    });

    it('no pisa firstName, source ni tags de un contacto que ya los tenía', async () => {
      // El caso real que reportó C2: un hotel de la base importada, con
      // nombre comercial, origen del ERP y tags de zona ya puestos.
      const contactoImportado = {
        firstName: 'HOTEL PLAYA GRANDE S.A.',
        source: 'Importacion ERP 2026',
        tags: ['base-2026', 'zona-caribe'],
      };
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(respuesta({ contact: { id: 'hotel-1' } })) // upsert
        .mockResolvedValueOnce(respuesta({ contact: contactoImportado })) // GET
        .mockResolvedValueOnce(respuesta({}))                             // PUT
        .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
        .mockResolvedValueOnce(respuestaOportunidad());
      await crearEstimate({ ...params, contactId: undefined }, { ...deps, fetchImpl });

      const cuerpoPut = JSON.parse(fetchImpl.mock.calls[2][1].body);
      expect('firstName' in cuerpoPut).toBe(false);
      expect('source' in cuerpoPut).toBe(false);
      expect(cuerpoPut.tags).toEqual(
        expect.arrayContaining(['base-2026', 'zona-caribe', 'cotizacion']),
      );
      expect(cuerpoPut.tags).toHaveLength(3);
    });

    it('nunca escribe city', async () => {
      const [get, put] = respuestasEnriquecimiento();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(respuesta({ contact: { id: 'nuevo-4' } }))
        .mockResolvedValueOnce(get)
        .mockResolvedValueOnce(put)
        .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
        .mockResolvedValueOnce(respuestaOportunidad());
      await crearEstimate({ ...params, contactId: undefined }, { ...deps, fetchImpl });

      const cuerpoUpsert = JSON.parse(fetchImpl.mock.calls[0][1].body);
      const cuerpoPut = JSON.parse(fetchImpl.mock.calls[2][1].body);
      expect('city' in cuerpoUpsert).toBe(false);
      expect('city' in cuerpoPut).toBe(false);
    });

    it('guarda el nombre de la persona en el campo personalizado, no sólo en firstName', async () => {
      const [get, put] = respuestasEnriquecimiento();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(respuesta({ contact: { id: 'nuevo-5' } }))
        .mockResolvedValueOnce(get)
        .mockResolvedValueOnce(put)
        .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
        .mockResolvedValueOnce(respuestaOportunidad());
      await crearEstimate({ ...params, contactId: undefined }, { ...deps, fetchImpl });

      const cuerpoPut = JSON.parse(fetchImpl.mock.calls[2][1].body);
      expect(cuerpoPut.customFields).toEqual([
        { key: 'contact.persona_contacto', field_value: 'Ana Pérez' },
      ]);
    });

    it('si el enriquecimiento del contacto falla, la cotización igual se crea', async () => {
      // El contacto ya quedó resuelto por el upsert; que falle el "afinado"
      // de tags/nombre no debe convertir una cotización válida en un error.
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(respuesta({ contact: { id: 'nuevo-6' } })) // upsert
        .mockResolvedValueOnce(respuesta({ message: 'boom' }, 500))       // GET falla
        .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
        .mockResolvedValueOnce(respuestaOportunidad());
      const r = await crearEstimate({ ...params, contactId: undefined }, { ...deps, fetchImpl });
      expect(r).toEqual({ ok: true, estimateId: 'est-1', contactId: 'nuevo-6' });
    });
  });

  describe('final-fix-C — el camino con `contactId` ya resuelto también enriquece el contacto', () => {
    // Antes de esta corrección, `resolverContacto` devolvía de inmediato en
    // cuanto recibía un `contactId` — sin pasar nunca por
    // `escribirContactoSinPisar`. Mientras la pantalla nunca mandara
    // `contactId` eso no importaba (el 100% de las cotizaciones caía en la
    // rama de alta, más abajo, que sí enriquece). Pero la corrección del
    // ciclo de borradores del agente activó justo esta rama para ese flujo:
    // "Usar" un borrador manda su `contactId` (ver `BorradorActivo` en
    // app/cotizador/Cotizador.tsx), y esas cotizaciones dejaron de tocar el
    // CRM — ni el tag `cotizacion`, ni `companyName`, ni `source`.
    it('llama a GET+PUT del enriquecimiento aunque el contactId ya venga resuelto', async () => {
      // Mutante que esto mata: el `if (p.contactId) return { ok: true,
      // contactId: p.contactId };` original — un `return` temprano que
      // salta CUALQUIER llamada de enriquecimiento. Con ese mutante de
      // vuelta, `fetchImpl` solo recibiría 2 llamadas (estimate +
      // oportunidad) en vez de 4, y esta prueba fallaría porque no
      // encontraría ningún GET a `/contacts/contacto-1`.
      const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
      await crearEstimate(params, { ...deps, fetchImpl });

      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(fetchImpl.mock.calls[0][0]).toContain('/contacts/contacto-1');
      expect(fetchImpl.mock.calls[0][1].body).toBeUndefined(); // GET: sin cuerpo.
      const cuerpoPut = JSON.parse(fetchImpl.mock.calls[1][1].body);
      expect(fetchImpl.mock.calls[1][1].method).toBe('PUT');
      expect(cuerpoPut.tags).toContain('cotizacion');
    });

    it('no pisa companyName ni source de un contacto ya resuelto que ya los tenía', async () => {
      // Mismo caso que C2, pero por el camino de `contactId` recibido (el
      // del borrador del agente), no por el de alta de un contacto nuevo.
      const contactoExistente = {
        companyName: 'Hotel Papagayo Original S.A.',
        source: 'Importacion ERP 2026',
        tags: ['zona-guanacaste'],
      };
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(respuesta({ contact: contactoExistente })) // GET
        .mockResolvedValueOnce(respuesta({}))                             // PUT
        .mockResolvedValueOnce(respuesta({ _id: 'est-1' }))
        .mockResolvedValueOnce(respuestaOportunidad());
      await crearEstimate(params, { ...deps, fetchImpl });

      const cuerpoPut = JSON.parse(fetchImpl.mock.calls[1][1].body);
      expect('companyName' in cuerpoPut).toBe(false);
      expect('source' in cuerpoPut).toBe(false);
      expect(cuerpoPut.tags).toEqual(expect.arrayContaining(['zona-guanacaste', 'cotizacion']));
    });
  });

  describe('C3 — detecta un pipelineStageId que GHL aceptó pero no aplicó', () => {
    it('reporta opportunityError cuando la etapa devuelta no coincide con la pedida', async () => {
      // Sondeado contra la API real: un pipelineStageId inválido responde 201
      // igual, y GHL deja la oportunidad en la primera etapa del pipeline sin
      // avisar. Mutante que esto mata: no comparar la respuesta y devolver
      // siempre éxito cuando `res.ok` es true.
      const fetchImpl = fetchConContactoConocido(
        respuesta({ _id: 'est-1' }),
        respuestaOportunidad('id-de-otra-etapa-cualquiera'),
      );
      const r = await crearEstimate(params, { ...deps, fetchImpl });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.opportunityError).toBeTruthy();
        expect(r.opportunityError).toContain(ETAPA_CALIFICADA_ID);
      }
    });

    it('no reporta error cuando la etapa devuelta sí coincide', async () => {
      const fetchImpl = fetchConContactoConocido(
        respuesta({ _id: 'est-1' }),
        respuestaOportunidad(ETAPA_CALIFICADA_ID),
      );
      const r = await crearEstimate(params, { ...deps, fetchImpl });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.opportunityError).toBeUndefined();
    });

    it('detecta también una etapa devuelta bajo `opportunity.pipelineStageId`', async () => {
      // La respuesta de GHL a veces envuelve el objeto en `opportunity`, a
      // veces no (mismo patrón visto en `_id`/`id` del estimate). La
      // comparación tiene que cubrir ambas formas.
      const fetchImpl = fetchConContactoConocido(
        respuesta({ _id: 'est-1' }),
        respuesta({ opportunity: { id: 'opp-1', pipelineStageId: ETAPA_CALIFICADA_ID } }),
      );
      const r = await crearEstimate(params, { ...deps, fetchImpl });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.opportunityError).toBeUndefined();
    });
  });

  describe('Ronda de correcciones 2 (hallazgos C1 e I1 de la revisión final)', () => {
    it('mueve la oportunidad a "Qualified", no a "Proposal Sent" — el Estimate nunca se envía', async () => {
      // Hallazgo C1: crearEstimate crea el Estimate en borrador y jamás lo
      // envía. Decir "Proposal Sent" sería mentir sobre un envío que no
      // ocurrió. Mutante que esto mata: volver a apuntar `moverOportunidad`
      // a `ETAPA_PROPUESTA_ID`.
      const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
      await crearEstimate(params, { ...deps, fetchImpl });
      const cuerpoOportunidad = JSON.parse(fetchImpl.mock.calls[3][1].body);
      expect(cuerpoOportunidad.pipelineStageId).toBe(ETAPA_CALIFICADA_ID);
      expect(cuerpoOportunidad.pipelineStageId).not.toBe(ETAPA_PROPUESTA_ID);
    });

    it('usa la fecha de Costa Rica, no la de UTC, para issueDate/expiryDate', async () => {
      // 01:30 UTC del 26 de agosto todavía es 25 de agosto, 7:30pm en Costa
      // Rica (UTC-6). Un servidor con reloj UTC —lo normal en Vercel—
      // imprimía el día siguiente si `formatearFecha` no formatea con el
      // huso horario correcto. Mutante que esto mata: volver a
      // `fecha.toISOString().slice(0, 10)`.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-26T01:30:00Z'));
      try {
        const fetchImpl = fetchConContactoConocido(respuesta({ _id: 'est-1' }), respuestaOportunidad());
        await crearEstimate(params, { ...deps, fetchImpl });
        const cuerpo = JSON.parse(fetchImpl.mock.calls[2][1].body);
        expect(cuerpo.issueDate).toBe('2026-08-25');
        expect(cuerpo.expiryDate).toBe('2026-09-24');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
