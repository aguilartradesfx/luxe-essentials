import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/cotizador/ghl', () => ({
  crearEstimate: vi.fn().mockResolvedValue({ ok: true, estimateId: 'est-1', contactId: 'contacto-ghl-1' }),
}));

const insertado: unknown[] = [];
const actualizado: unknown[] = [];
let errorAlActualizar: { message: string } | null = null;
vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: (fila: unknown) => {
        insertado.push(fila);
        return {
          select: () => ({
            single: async () => ({ data: { id: 'cot-1', ...(fila as object) }, error: null }),
          }),
        };
      },
      update: (cambios: unknown) => {
        actualizado.push(cambios);
        return { eq: async () => ({ error: errorAlActualizar }) };
      },
    }),
  }),
}));

const { POST } = await import('@/app/api/cotizacion/route');
const { crearEstimate } = await import('@/lib/cotizador/ghl');

function peticion(cuerpo: unknown) {
  return new Request('http://localhost/api/cotizacion', {
    method: 'POST',
    body: JSON.stringify(cuerpo),
  });
}

const valido = {
  clave: 'secreta',
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
  lineas: [{ skuId: 'set-600-king', cantidad: 16 }],
};

describe('POST /api/cotizacion', () => {
  beforeEach(() => {
    insertado.length = 0;
    actualizado.length = 0;
    errorAlActualizar = null;
    process.env.LUXE_TALLER_CLAVE = 'secreta';
    vi.mocked(crearEstimate).mockResolvedValue({ ok: true, estimateId: 'est-1', contactId: 'contacto-ghl-1' });
  });

  it('rechaza sin clave', async () => {
    const res = await POST(peticion({ ...valido, clave: 'otra' }));
    expect(res.status).toBe(401);
  });

  it('rechaza con clave incorrecta antes de mirar la forma del cuerpo (401, no 400)', async () => {
    // El cuerpo está estructuralmente roto (lineas no es un arreglo, cliente
    // no es un objeto): si el endpoint validara el esquema antes que la
    // clave, esto daría 400 y filtraría por qué campo falló. Debe dar 401
    // sin que Zod llegue a mirarlo. Esto es la red de la corrección de orden
    // clave-antes-que-esquema: si un refactor la deshace, esta prueba lo nota.
    const res = await POST(
      peticion({ clave: 'otra', cliente: 'no soy un objeto', lineas: 'tampoco un arreglo' }),
    );
    expect(res.status).toBe(401);
  });

  it('rechaza un cuerpo que no es JSON', async () => {
    const res = await POST(
      new Request('http://localhost/api/cotizacion', { method: 'POST', body: 'no soy json' }),
    );
    expect(res.status).toBe(400);
  });

  it('rechaza un correo inválido', async () => {
    const res = await POST(peticion({ ...valido, cliente: { ...valido.cliente, email: 'roto' } }));
    expect(res.status).toBe(400);
  });

  it('rechaza una cotización sin líneas', async () => {
    const res = await POST(peticion({ ...valido, lineas: [] }));
    expect(res.status).toBe(400);
  });

  it('avisa en español si "cliente" no es un objeto', async () => {
    // Ronda 2: los mensajes de las reglas (min/max) ya estaban en español,
    // pero los de tipo (invalid_type) seguían en el inglés por defecto de
    // Zod. Un vendedor autenticado con un front roto vería ese inglés.
    const res = await POST(peticion({ ...valido, cliente: 'no soy un objeto' }));
    expect(res.status).toBe(400);
    const cuerpo = await res.json();
    expect(cuerpo.error).not.toMatch(/invalid input|expected/i);
    expect(cuerpo.error).toMatch(/objeto/i);
  });

  it('avisa en español si "lineas" no es un arreglo', async () => {
    const res = await POST(peticion({ ...valido, lineas: 'tampoco un arreglo' }));
    expect(res.status).toBe(400);
    const cuerpo = await res.json();
    expect(cuerpo.error).not.toMatch(/invalid input|expected/i);
    expect(cuerpo.error).toMatch(/arreglo/i);
  });

  it('avisa en español si "bordadoEspecial" no es booleano', async () => {
    const res = await POST(peticion({ ...valido, bordadoEspecial: 'si' }));
    expect(res.status).toBe(400);
    const cuerpo = await res.json();
    expect(cuerpo.error).not.toMatch(/invalid input|expected/i);
    expect(cuerpo.error).toMatch(/verdadero o falso/i);
  });

  it('rechaza un sku que no existe', async () => {
    const res = await POST(peticion({ ...valido, lineas: [{ skuId: 'fantasma', cantidad: 1 }] }));
    expect(res.status).toBe(400);
  });

  it('devuelve el cálculo y guarda la fila', async () => {
    const res = await POST(peticion(valido));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.cotizacion.lineas[0].descuentoPct).toBe(10);
    expect(insertado).toHaveLength(1);
  });

  it('guarda en la base los valores que la tabla permite, calculados por el servidor', async () => {
    // El "navegador" manda montos falsos colgados de la línea: si el endpoint
    // alguna vez guardara `datos.lineas` (la entrada cruda) en vez del
    // resultado de `calcular`, estos valores basura sobrevivirían hasta la
    // fila. Zod ya los descarta al parsear, y el servidor además nunca los
    // lee para calcular: esta prueba comprueba las dos cosas mirando adentro
    // de `insertado`, no solo su longitud.
    const conBasura = {
      ...valido,
      lineas: [
        {
          skuId: 'set-600-king',
          cantidad: 16,
          precioUnitario: 1,
          subtotal: 1,
          descuentoPct: 999,
        },
      ],
    };
    const res = await POST(peticion(conBasura));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();

    expect(insertado).toHaveLength(1);
    const fila = insertado[0] as Record<string, unknown>;

    // Exactamente los valores que el `check` de la tabla permite (origen:
    // humano/agente, estado: borrador/enviada/error), no cualquier string
    // parecido.
    expect(fila.origen).toBe('humano');
    expect(fila.estado).toBe('borrador');

    // Lo guardado es el cálculo del servidor, no el eco de lo que llegó.
    expect(fila.lineas).toEqual(cuerpo.cotizacion.lineas);
    expect(fila.totales).toEqual({
      subtotal: cuerpo.cotizacion.subtotal,
      ahorro: cuerpo.cotizacion.ahorro,
      tasaIva: cuerpo.cotizacion.tasaIva,
      iva: cuerpo.cotizacion.iva,
      total: cuerpo.cotizacion.total,
      bordadoEspecial: cuerpo.cotizacion.bordadoEspecial,
    });

    // Los montos falsos no sobreviven: el precio y el descuento son los que
    // calculó el motor, no los que mandó el cliente.
    const lineaGuardada = fila.lineas as Array<Record<string, unknown>>;
    expect(lineaGuardada[0].precioUnitario).not.toBe(1);
    expect(lineaGuardada[0].subtotal).not.toBe(1);
    expect(lineaGuardada[0].descuentoPct).not.toBe(999);
    expect(lineaGuardada[0].descuentoPct).toBe(10);
  });

  it('rechaza una cantidad por línea absurdamente grande', async () => {
    // Sin tope, `cantidad: 1e15` pasaría el esquema, `calcular` produciría un
    // total fuera de `Number.isSafeInteger`, y ese número terminaría en el
    // jsonb y luego en el Estimate. Este es el guardarraíl de cordura, no una
    // regla de negocio.
    const res = await POST(
      peticion({ ...valido, lineas: [{ skuId: 'set-600-king', cantidad: 1e15 }] }),
    );
    expect(res.status).toBe(400);
  });

  it('acepta una tasa de IVA distinta', async () => {
    const res = await POST(peticion({ ...valido, tasaIva: 0.01 }));
    const cuerpo = await res.json();
    expect(cuerpo.cotizacion.tasaIva).toBe(0.01);
  });

  it('devuelve el id del estimate de GoHighLevel', async () => {
    const res = await POST(peticion(valido));
    const cuerpo = await res.json();
    expect(cuerpo.ghl.estimateId).toBe('est-1');
  });

  // --- Ronda de correcciones 1 ---

  it('guarda estado "enviada", el estimateId y el contactId cuando GoHighLevel responde ok', async () => {
    await POST(peticion(valido));
    expect(actualizado).toHaveLength(1);
    expect(actualizado[0]).toMatchObject({
      estado: 'enviada',
      ghl_estimate_id: 'est-1',
      contact_id: 'contacto-ghl-1',
    });
  });

  it('guarda estado "error" y ghl_error cuando crearEstimate falla (camino de fallo antes no probado)', async () => {
    // Antes de esta ronda, `crearEstimate` estaba mockeado siempre en
    // `ok: true`, así que `estado: 'error'` — el contrato de recuperabilidad
    // completo — nunca se ejercitaba. Un mutante que escribiera 'enviado' en
    // vez de 'enviada' (rechazado por el `check` de la tabla) sobrevivía.
    vi.mocked(crearEstimate).mockResolvedValueOnce({ ok: false, error: 'GHL estimate 500: boom' });
    const res = await POST(peticion(valido));
    const cuerpo = await res.json();

    expect(cuerpo.ghl.error).toContain('boom');
    expect(actualizado).toHaveLength(1);
    expect(actualizado[0]).toMatchObject({
      estado: 'error',
      ghl_error: expect.stringContaining('boom'),
    });
    // El estado que el check de la tabla realmente acepta, no un string
    // parecido: mata el mutante 'enviado' vs 'enviada'.
    expect((actualizado[0] as { estado: string }).estado).toBe('error');
  });

  it('guarda el contactId aunque crearEstimate falle, si se llegó a resolver uno', async () => {
    vi.mocked(crearEstimate).mockResolvedValueOnce({
      ok: false,
      error: 'GHL estimate 500: boom',
      contactId: 'nuevo-antes-de-fallar',
    });
    await POST(peticion(valido));
    expect(actualizado[0]).toMatchObject({ estado: 'error', contact_id: 'nuevo-antes-de-fallar' });
  });

  it('guarda estado "enviada" con el ghl_error de la Opportunity, sin marcar error', async () => {
    // Un fallo moviendo la Opportunity no invalida un Estimate que ya se creó
    // bien: la fila debe seguir en 'enviada', con el detalle del fallo en
    // ghl_error para que alguien lo revise, no como si la cotización entera
    // hubiera fallado.
    vi.mocked(crearEstimate).mockResolvedValueOnce({
      ok: true,
      estimateId: 'est-2',
      contactId: 'contacto-x',
      opportunityError: 'GHL oportunidad 422: property pipelineStageName should not exist',
    });
    const res = await POST(peticion(valido));
    const cuerpo = await res.json();

    expect(cuerpo.ghl.estimateId).toBe('est-2');
    expect(actualizado[0]).toMatchObject({
      estado: 'enviada',
      ghl_estimate_id: 'est-2',
      ghl_error: expect.stringContaining('pipelineStageName'),
      contact_id: 'contacto-x',
    });
  });

  it('usa el contactId recibido del vendedor si GoHighLevel no devuelve uno', async () => {
    // El dato ya está en la mano en el momento del insert: no debería
    // perderse si `crearEstimate` no lo repite en su resultado.
    vi.mocked(crearEstimate).mockResolvedValueOnce({ ok: true, estimateId: 'est-3' } as never);
    await POST(peticion({ ...valido, contactId: 'contacto-del-vendedor' }));
    expect(actualizado[0]).toMatchObject({ contact_id: 'contacto-del-vendedor' });
  });

  it('registra en consola si falla el update de Supabase, sin tumbar la respuesta', async () => {
    // El Estimate ya se gestionó en GoHighLevel en este punto: que el update
    // falle no debe convertirse en un 500 para el vendedor, que ya tiene su
    // cotización creada. Pero el fallo debe quedar registrado, no descartado
    // en silencio.
    errorAlActualizar = { message: 'conexión perdida' };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(peticion(valido));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.ghl.estimateId).toBe('est-1');
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('no se pudo actualizar'),
      'conexión perdida',
    );
    consoleError.mockRestore();
  });
});
