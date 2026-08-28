import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/cotizador/ghl', () => ({
  crearEstimate: vi.fn().mockResolvedValue({ ok: true, estimateId: 'est-1', contactId: 'contacto-ghl-1' }),
}));

// Tarea 5: el PDF, el guardado en Storage y el correo se simulan igual que
// GoHighLevel arriba — nunca lanzan salvo que una prueba puntual lo pida con
// `mockRejectedValueOnce`/`mockResolvedValueOnce`.
vi.mock('@/lib/cotizador/documento', () => ({
  renderizarCotizacion: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7 falso')),
}));
vi.mock('@/lib/cotizador/almacen', () => ({
  guardarPdf: vi.fn().mockResolvedValue({ ok: true, ruta: '2026/COT-1-abc.pdf' }),
  enlaceFirmado: vi.fn().mockResolvedValue({ ok: true, url: 'https://firmada' }),
}));
vi.mock('@/lib/cotizador/correo', () => ({
  enviarCotizacion: vi.fn().mockResolvedValue({ ok: true, resendId: 're_1' }),
}));

const insertado: unknown[] = [];
const actualizados: unknown[] = [];
let errorAlActualizar: { message: string } | null = null;
vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: (fila: unknown) => {
        insertado.push(fila);
        return {
          select: () => ({
            // `numero` simula lo que en la base pone el trigger de la
            // migración 0010 (`obtener_numero_cotizacion`): el insert nunca lo
            // manda, la fila vuelve con él puesto.
            single: async () => ({ data: { id: 'cot-1', numero: 'COT-2026-0001', ...(fila as object) }, error: null }),
          }),
        };
      },
      update: (cambios: unknown) => {
        actualizados.push(cambios);
        return { eq: async () => ({ error: errorAlActualizar }) };
      },
    }),
  }),
}));

const { POST } = await import('@/app/api/cotizacion/route');
const { crearEstimate } = await import('@/lib/cotizador/ghl');
const { renderizarCotizacion } = await import('@/lib/cotizador/documento');
const { guardarPdf, enlaceFirmado } = await import('@/lib/cotizador/almacen');
const { enviarCotizacion } = await import('@/lib/cotizador/correo');

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
    actualizados.length = 0;
    errorAlActualizar = null;
    process.env.LUXE_TALLER_CLAVE = 'secreta';
    vi.mocked(crearEstimate).mockResolvedValue({ ok: true, estimateId: 'est-1', contactId: 'contacto-ghl-1' });
    // `mockClear` (no `mockReset`): borra el historial de llamadas de la
    // prueba anterior sin perder el `mockResolvedValue` por defecto de cada
    // mock, fijado arriba en `vi.mock`. Sin esto, `enviarCotizacion` (y los
    // demás) acumulan llamadas de todas las pruebas anteriores y
    // `not.toHaveBeenCalled()` nunca podría dar verdadero.
    vi.mocked(renderizarCotizacion).mockClear();
    vi.mocked(guardarPdf).mockClear();
    vi.mocked(enlaceFirmado).mockClear();
    vi.mocked(enviarCotizacion).mockClear();
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
    // humano/agente, estado: borrador/creada/enviada/error/convertida), no
    // cualquier string parecido.
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

  it('guarda estado "enviada", el estimateId y el contactId cuando GoHighLevel y el correo responden ok', async () => {
    // Tarea 5: el `estado` ya no depende de GoHighLevel — `crearEstimate`
    // sigue sin llamar al envío de GoHighLevel, pero ahora existe un envío
    // real (correo con el PDF de Luxe adjunto, vía `enviarCotizacion`).
    // 'enviada' describe eso: la cotización de verdad salió hacia el cliente.
    await POST(peticion(valido));
    expect(actualizados).toHaveLength(1);
    expect(actualizados[0]).toMatchObject({
      estado: 'enviada',
      ghl_estimate_id: 'est-1',
      contact_id: 'contacto-ghl-1',
    });
  });

  it('guarda ghl_error cuando crearEstimate falla, pero el estado sigue "enviada" si el correo salió (el fallo de GoHighLevel no invalida un envío que sí llegó)', async () => {
    // Restricción global del plan: "Ningún fallo de GoHighLevel invalida una
    // cotización que ya salió al cliente." Antes de la Tarea 5 el único
    // envío era el Estimate de GoHighLevel, así que su fallo marcaba
    // 'error'. Ahora el envío real es el correo (mockeado en éxito por
    // defecto en este archivo), así que un fallo de GoHighLevel debe quedar
    // registrado en `ghl_error` sin bajar el estado.
    vi.mocked(crearEstimate).mockResolvedValueOnce({ ok: false, error: 'GHL estimate 500: boom' });
    const res = await POST(peticion(valido));
    const cuerpo = await res.json();

    expect(cuerpo.ghl.error).toContain('boom');
    expect(actualizados).toHaveLength(1);
    expect(actualizados[0]).toMatchObject({
      estado: 'enviada',
      ghl_error: expect.stringContaining('boom'),
    });
  });

  it('guarda estado "error" y ghl_error cuando tanto crearEstimate como el correo fallan (camino de fallo antes no probado)', async () => {
    // Antes de esta ronda, `crearEstimate` estaba mockeado siempre en
    // `ok: true`, así que `estado: 'error'` — el contrato de recuperabilidad
    // completo — nunca se ejercitaba. Un mutante que escribiera 'enviado' en
    // vez de 'enviada' (rechazado por el `check` de la tabla) sobrevivía.
    const { enviarCotizacion } = await import('@/lib/cotizador/correo');
    vi.mocked(crearEstimate).mockResolvedValueOnce({ ok: false, error: 'GHL estimate 500: boom' });
    vi.mocked(enviarCotizacion).mockResolvedValueOnce({ ok: false, error: 'dominio no verificado' });
    const res = await POST(peticion(valido));
    const cuerpo = await res.json();

    expect(cuerpo.ghl.error).toContain('boom');
    expect(actualizados).toHaveLength(1);
    expect(actualizados[0]).toMatchObject({
      estado: 'error',
      ghl_error: expect.stringContaining('boom'),
    });
    // El estado que el check de la tabla realmente acepta, no un string
    // parecido: mata el mutante 'enviado' vs 'enviada'.
    expect((actualizados[0] as { estado: string }).estado).toBe('error');
  });

  it('guarda el contactId aunque crearEstimate falle, si se llegó a resolver uno', async () => {
    vi.mocked(crearEstimate).mockResolvedValueOnce({
      ok: false,
      error: 'GHL estimate 500: boom',
      contactId: 'nuevo-antes-de-fallar',
    });
    await POST(peticion(valido));
    // El correo sigue en éxito por defecto: el contactId se guarda pase lo
    // que pase con GoHighLevel, y el estado no baja por su fallo.
    expect(actualizados[0]).toMatchObject({ estado: 'enviada', contact_id: 'nuevo-antes-de-fallar' });
  });

  it('guarda estado "enviada" con el ghl_error de la Opportunity, sin marcar error', async () => {
    // Un fallo moviendo la Opportunity no invalida ni el Estimate que ya se
    // creó bien ni el correo que sí salió: la fila queda 'enviada', con el
    // detalle del fallo en ghl_error para que alguien lo revise, no como si
    // la cotización entera hubiera fallado.
    vi.mocked(crearEstimate).mockResolvedValueOnce({
      ok: true,
      estimateId: 'est-2',
      contactId: 'contacto-x',
      opportunityError: 'GHL oportunidad 422: property pipelineStageName should not exist',
    });
    const res = await POST(peticion(valido));
    const cuerpo = await res.json();

    expect(cuerpo.ghl.estimateId).toBe('est-2');
    expect(actualizados[0]).toMatchObject({
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
    expect(actualizados[0]).toMatchObject({ contact_id: 'contacto-del-vendedor' });
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

  // --- Ronda de correcciones 2 (hallazgo I1) ---

  it('cierra el borrador del agente ("convertida") cuando el envío llega con borradorId', async () => {
    // Sin esto, el borrador del agente se queda en 'borrador' para siempre:
    // la cola del vendedor nunca se vacía y `registrarIntencion`
    // (lib/cotizador/borrador.ts) no vuelve a registrar una intención de ese
    // contacto jamás, porque esa función corta si ya hay un 'borrador'
    // abierto suyo.
    await POST(peticion({ ...valido, borradorId: 'borrador-9' }));
    expect(actualizados).toHaveLength(2);
    expect(actualizados[0]).toMatchObject({ estado: 'convertida' });
  });

  it('no toca ningún borrador cuando la cotización no viene de uno', async () => {
    // Mata el mutante "cerrar el borrador siempre, tenga o no borradorId":
    // sin `borradorId` en el cuerpo, solo debe correr el update final de
    // GoHighLevel — nunca un segundo update de cierre.
    await POST(peticion(valido));
    expect(actualizados).toHaveLength(1);
  });

  it('cierra el borrador aunque crearEstimate falle después (el cierre no depende de GoHighLevel)', async () => {
    vi.mocked(crearEstimate).mockResolvedValueOnce({ ok: false, error: 'GHL estimate 500: boom' });
    await POST(peticion({ ...valido, borradorId: 'borrador-10' }));
    expect(actualizados).toHaveLength(2);
    expect(actualizados[0]).toMatchObject({ estado: 'convertida' });
    // El correo sigue en éxito por defecto: el fallo de GoHighLevel queda
    // registrado en ghl_error, pero no baja el estado a 'error' — la
    // cotización sí llegó al cliente.
    expect(actualizados[1]).toMatchObject({ estado: 'enviada', ghl_error: expect.stringContaining('boom') });
  });

  it('registra en consola si falla el cierre del borrador, sin tumbar la respuesta', async () => {
    errorAlActualizar = { message: 'fila bloqueada' };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(peticion({ ...valido, borradorId: 'borrador-11' }));
    expect(res.status).toBe(200);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('No se pudo cerrar el borrador'),
      'fila bloqueada',
    );
    consoleError.mockRestore();
  });

  // --- Tarea 5: el PDF, el guardado y el correo ---

  it('genera el PDF, lo guarda y manda el correo', async () => {
    const res = await POST(peticion(valido));
    const cuerpo = await res.json();
    expect(cuerpo.pdf.ruta).toBe('2026/COT-1-abc.pdf');
    expect(cuerpo.correo.resendId).toBe('re_1');
  });

  it('guarda la ruta del PDF y el id de Resend en la fila', async () => {
    await POST(peticion(valido));
    const actualizado = actualizados[actualizados.length - 1] as Record<string, unknown>;
    expect(actualizado.pdf_ruta).toBe('2026/COT-1-abc.pdf');
    expect(actualizado.resend_id).toBe('re_1');
    expect(actualizado.enviado_at).toBeTruthy();
  });

  it('si el correo falla, la cotización queda en error y es recuperable', async () => {
    const { enviarCotizacion } = await import('@/lib/cotizador/correo');
    vi.mocked(enviarCotizacion).mockResolvedValueOnce({ ok: false, error: 'dominio no verificado' });
    const res = await POST(peticion(valido));
    const cuerpo = await res.json();
    expect(cuerpo.correo.error).toContain('dominio');
    const actualizado = actualizados[actualizados.length - 1] as Record<string, unknown>;
    expect(actualizado.estado).toBe('error');
  });

  it('si el PDF falla, no intenta mandar un correo sin adjunto', async () => {
    const { renderizarCotizacion } = await import('@/lib/cotizador/documento');
    const { enviarCotizacion } = await import('@/lib/cotizador/correo');
    vi.mocked(renderizarCotizacion).mockRejectedValueOnce(new Error('sin fuentes'));
    const res = await POST(peticion(valido));
    expect((await res.json()).ok).toBe(true);
    expect(enviarCotizacion).not.toHaveBeenCalled();
  });

  it('si el PDF falla, la respuesta no trae ruta de PDF y el correo queda registrado como error, sin tumbar el endpoint', async () => {
    const { renderizarCotizacion } = await import('@/lib/cotizador/documento');
    vi.mocked(renderizarCotizacion).mockRejectedValueOnce(new Error('sin fuentes'));
    const res = await POST(peticion(valido));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.pdf).toBeNull();
    expect(cuerpo.correo.error).toBeTruthy();
    const actualizado = actualizados[actualizados.length - 1] as Record<string, unknown>;
    expect(actualizado.estado).toBe('error');
    expect(actualizado.pdf_ruta).toBeUndefined();
  });

  it('usa el numero real de la fila (el que puso el trigger), no uno derivado del id', async () => {
    // El mock del insert (arriba) devuelve `id: 'cot-1'` y
    // `numero: 'COT-2026-0001'` — deliberadamente distintos, para que un
    // mutante que derive el número del id (`` `COT-2026-${data.id}` `` →
    // 'COT-2026-cot-1') no pueda esconderse detrás de una coincidencia. Esta
    // es exactamente la regla que el brief dedica un párrafo a prohibir.
    await POST(peticion(valido));
    expect(vi.mocked(renderizarCotizacion).mock.calls[0][0]).toMatchObject({ numero: 'COT-2026-0001' });
    expect(vi.mocked(guardarPdf).mock.calls[0][0]).toMatchObject({ numero: 'COT-2026-0001' });
    expect(vi.mocked(enviarCotizacion).mock.calls[0][0]).toMatchObject({ numero: 'COT-2026-0001' });
    expect(vi.mocked(renderizarCotizacion).mock.calls[0][0].numero).not.toBe('COT-2026-cot-1');
  });

  it('si guardarPdf falla, no intenta mandar el correo (el adjunto nunca se guardó) y la respuesta no trae ruta de PDF', async () => {
    // Distinto del caso "el PDF no se generó" (renderizarCotizacion falla):
    // acá el PDF sí existe en memoria, pero no llegó a Storage. Sin esto, el
    // correo saldría con un adjunto que nunca quedó guardado del lado de
    // Luxe — el enlace firmado del correo apuntaría a un archivo que no
    // existe.
    vi.mocked(guardarPdf).mockResolvedValueOnce({ ok: false, error: 'bucket lleno' });
    const res = await POST(peticion(valido));
    const cuerpo = await res.json();
    expect(cuerpo.pdf).toBeNull();
    expect(cuerpo.correo.error).toContain('bucket lleno');
    expect(enviarCotizacion).not.toHaveBeenCalled();
    const actualizado = actualizados[actualizados.length - 1] as Record<string, unknown>;
    expect(actualizado.estado).toBe('error');
    expect(actualizado.pdf_ruta).toBeUndefined();
  });

  it('guarda teléfono y dirección del cliente cuando vienen en el envío', async () => {
    // El esquema los acepta como opcionales (Tarea 5): la fila guarda
    // exactamente el `cliente` validado, sin recortar estos dos campos.
    const res = await POST(
      peticion({
        ...valido,
        cliente: { ...valido.cliente, telefono: '+506 8888-8888', direccion: 'Frente al parque, Liberia' },
      }),
    );
    expect(res.status).toBe(200);
    const fila = insertado[insertado.length - 1] as Record<string, unknown>;
    expect(fila.cliente).toMatchObject({
      telefono: '+506 8888-8888',
      direccion: 'Frente al parque, Liberia',
    });
  });
});
