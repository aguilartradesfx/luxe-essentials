import { describe, it, expect, vi, beforeEach } from 'vitest';

// Tarea 8: los cuatro endpoints que consume la pantalla del panel —listar,
// medir, cerrar y reenviar—. Mismo patrón que tests/api-borradores.test.ts:
// Supabase simulado, `Request` armado a mano, sin red.
//
// Ronda de correcciones 1: sumó, además de los casos obligatorios del
// brief, las pruebas que un mutante barato sobrevivía (ver comentarios en
// cada `it`).

vi.mock('@/lib/cotizador/almacen', () => ({
  BUCKET: 'cotizaciones',
  enlaceFirmado: vi.fn().mockResolvedValue({ ok: true, url: 'https://firmada' }),
}));
vi.mock('@/lib/cotizador/correo', () => ({
  enviarCotizacion: vi.fn().mockResolvedValue({ ok: true, resendId: 're_9' }),
}));

// IDs con forma de UUID v4 real: /cerrar y /reenviar validan `id` con
// `z.uuid()` (ronda de correcciones 1) — un `id` como 'cot-1' ya no pasa el
// esquema.
const ID_VALIDO = 'a1b2c3d4-0000-4000-8000-000000000001';
const ID_INEXISTENTE = 'b2c3d4e5-0000-4000-8000-000000000002';

// Estado mutable que cada prueba configura antes de llamar a la ruta. Vive
// fuera del módulo mockeado (es del propio archivo de prueba), igual que
// `filtros` en tests/api-borradores.test.ts.
let resultadoLista: { data: unknown; error: { message: string } | null } = { data: [], error: null };
let resultadoFila: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let resultadoActualizacion: { error: { message: string } | null } = { error: null };
let resultadoActualizacionConSelect: { data: unknown; error: { message: string } | null } = {
  data: [{ id: ID_VALIDO }],
  error: null,
};
let resultadoDescarga: { data: unknown; error: { message: string } | null } = {
  data: { arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7 falso').buffer },
  error: null,
};

const columnasSeleccionadas: string[] = [];
const filtrosSelect: [string, string, string][] = [];
const limitesSeleccionados: number[] = [];
const filtrosUpdate: [string, string, string][] = [];
const actualizaciones: unknown[] = [];

// Cadena de lectura: `select().eq()?.in()?.order()?.limit()`, o `.single()`/
// `.maybeSingle()` en vez de `.limit()`. También sirve como "thenable" para
// cuando el código hace `await ....select(...)` sin ningún método más
// (como hace /metricas).
function construirLectura(): any {
  const nodo: any = {
    eq: (columna: string, valor: string) => {
      filtrosSelect.push(['eq', columna, String(valor)]);
      return construirLectura();
    },
    in: (columna: string, valores: readonly string[]) => {
      filtrosSelect.push(['in', columna, valores.join(',')]);
      return construirLectura();
    },
    order: () => construirLectura(),
    limit: async (n: number) => {
      limitesSeleccionados.push(n);
      return resultadoLista;
    },
    single: async () => resultadoFila,
    maybeSingle: async () => resultadoFila,
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve(resultadoLista).then(resolve, reject),
  };
  return nodo;
}

// Cadena de escritura: `update(cambios).eq()?.in()?.select()`. Sin
// `.select()`, se resuelve directo con `resultadoActualizacion` (lo que
// espera /reenviar); con `.select()`, con `resultadoActualizacionConSelect`
// (lo que espera /cerrar, que necesita saber si el `update` tocó alguna fila).
function construirEscritura(cambios: unknown): any {
  actualizaciones.push(cambios);
  const nodo: any = {
    eq: (columna: string, valor: string) => {
      filtrosUpdate.push(['eq', columna, String(valor)]);
      return nodo;
    },
    in: (columna: string, valores: readonly string[]) => {
      filtrosUpdate.push(['in', columna, valores.join(',')]);
      return nodo;
    },
    select: () => Promise.resolve(resultadoActualizacionConSelect),
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve(resultadoActualizacion).then(resolve, reject),
  };
  return nodo;
}

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: (columnas: string) => {
        columnasSeleccionadas.push(columnas);
        return construirLectura();
      },
      update: (cambios: unknown) => construirEscritura(cambios),
    }),
    storage: {
      from: () => ({ download: async () => resultadoDescarga }),
    },
  }),
}));

const { POST: postListado } = await import('@/app/api/cotizacion/listado/route');
const { POST: postMetricas } = await import('@/app/api/cotizacion/metricas/route');
const { POST: postCerrar } = await import('@/app/api/cotizacion/cerrar/route');
const { POST: postReenviar } = await import('@/app/api/cotizacion/reenviar/route');
const { enlaceFirmado } = await import('@/lib/cotizador/almacen');
const { enviarCotizacion } = await import('@/lib/cotizador/correo');
const { emitirSesion } = await import('@/lib/sesion');

function peticion(url: string, cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabeceras },
    body: JSON.stringify(cuerpo),
  });
}

beforeEach(() => {
  process.env.LUXE_TALLER_CLAVE = 'secreta';
  process.env.RESEND_API_KEY = 'llave';
  process.env.LUXE_CORREO_REMITENTE = 'Luxe Essentials <cotizaciones@luxe.cr>';

  resultadoLista = { data: [], error: null };
  resultadoFila = { data: null, error: null };
  resultadoActualizacion = { error: null };
  resultadoActualizacionConSelect = { data: [{ id: ID_VALIDO }], error: null };
  resultadoDescarga = {
    data: { arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7 falso').buffer },
    error: null,
  };

  columnasSeleccionadas.length = 0;
  filtrosSelect.length = 0;
  limitesSeleccionados.length = 0;
  filtrosUpdate.length = 0;
  actualizaciones.length = 0;

  vi.mocked(enlaceFirmado).mockClear();
  vi.mocked(enlaceFirmado).mockResolvedValue({ ok: true, url: 'https://firmada' });
  vi.mocked(enviarCotizacion).mockClear();
  vi.mocked(enviarCotizacion).mockResolvedValue({ ok: true, resendId: 're_9' });
});

const filaListado = {
  id: 'cot-1',
  numero: 'COT-2026-0001',
  created_at: '2026-08-20T10:00:00Z',
  updated_at: '2026-08-20T10:00:00Z',
  estado: 'enviada',
  origen: 'humano',
  contact_id: 'contacto-ghl-1',
  cliente: { nombre: 'Ana Pérez', email: 'ana@hotel.com' },
  totales: { subtotal: 500000, ahorro: 0, iva: 65000, total: 565000 },
  enviado_at: '2026-08-20T10:05:00Z',
  cerrada_at: null,
  pdf_ruta: '2026/COT-2026-0001-cot-1.pdf',
  motivo_cierre: null,
  ghl_estimate_id: 'est-1',
  ghl_error: null,
};

describe('POST /api/cotizacion/listado', () => {
  it('rechaza sin credencial', async () => {
    const res = await postListado(peticion('http://localhost/api/cotizacion/listado', { clave: 'otra' }));
    expect(res.status).toBe(401);
  });

  it('devuelve las filas con su estado', async () => {
    resultadoLista = { data: [filaListado], error: null };
    const res = await postListado(peticion('http://localhost/api/cotizacion/listado', { clave: 'secreta' }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.cotizaciones).toHaveLength(1);
    expect(cuerpo.cotizaciones[0].estado).toBe('enviada');
  });

  it('filtra por estado cuando se le pasa uno', async () => {
    resultadoLista = { data: [filaListado], error: null };
    await postListado(peticion('http://localhost/api/cotizacion/listado', { clave: 'secreta', estado: 'enviada' }));
    expect(filtrosSelect).toEqual([['eq', 'estado', 'enviada']]);
  });

  it('no filtra por estado cuando no se le pasa uno', async () => {
    resultadoLista = { data: [filaListado], error: null };
    await postListado(peticion('http://localhost/api/cotizacion/listado', { clave: 'secreta' }));
    expect(filtrosSelect).toEqual([]);
  });

  it('no pide (ni por lo tanto devuelve) las lineas completas: son muchos datos por fila', async () => {
    resultadoLista = { data: [filaListado], error: null };
    const res = await postListado(peticion('http://localhost/api/cotizacion/listado', { clave: 'secreta' }));
    const cuerpo = await res.json();
    expect(columnasSeleccionadas[0]).not.toMatch(/\blineas\b/);
    expect(cuerpo.cotizaciones[0].lineas).toBeUndefined();
  });

  it('incluye el contact_id para poder enlazar a GoHighLevel', async () => {
    resultadoLista = { data: [filaListado], error: null };
    const res = await postListado(peticion('http://localhost/api/cotizacion/listado', { clave: 'secreta' }));
    const cuerpo = await res.json();
    expect(cuerpo.cotizaciones[0].contact_id).toBe('contacto-ghl-1');
  });

  // Ronda de correcciones 1 (mutante sobreviviente): nada probaba el tope.
  it('nunca pide más de 200 filas, aunque se pida un límite mayor', async () => {
    resultadoLista = { data: [], error: null };
    await postListado(peticion('http://localhost/api/cotizacion/listado', { clave: 'secreta', limite: 500 }));
    expect(limitesSeleccionados).toEqual([200]);
  });

  // Ronda de correcciones 1 (mutante sobreviviente): las pruebas anteriores
  // entraban todas con clave en el cuerpo, nunca por cookie — así el panel,
  // que vive en un iframe de GoHighLevel y entra por cookie, nunca quedaba
  // cubierto. Si alguien pone `requiereCsrf: true` "por las dudas" en esta
  // ruta de lectura, esta prueba (y no una de clave) es la que lo nota.
  it('funciona por cookie de sesión, sin exigir el token anti-CSRF', async () => {
    resultadoLista = { data: [filaListado], error: null };
    const { cookie } = emitirSesion();
    const valor = cookie.split(';')[0];
    const res = await postListado(peticion('http://localhost/api/cotizacion/listado', {}, { cookie: valor }));
    expect(res.status).toBe(200);
  });

  it('errores de base dan 500 con mensaje genérico', async () => {
    resultadoLista = { data: null, error: { message: 'la base está caída' } };
    const res = await postListado(peticion('http://localhost/api/cotizacion/listado', { clave: 'secreta' }));
    expect(res.status).toBe(500);
    const cuerpo = await res.json();
    expect(cuerpo.error).not.toContain('la base está caída');
  });
});

describe('POST /api/cotizacion/metricas', () => {
  it('rechaza sin credencial', async () => {
    const res = await postMetricas(peticion('http://localhost/api/cotizacion/metricas', { clave: 'otra' }));
    expect(res.status).toBe(401);
  });

  it('devuelve la forma que produce calcularMetricas', async () => {
    const filas = [
      {
        id: 'cot-1',
        created_at: '2026-08-01T10:00:00Z',
        enviado_at: '2026-08-01T10:05:00Z',
        cerrada_at: '2026-08-05T10:05:00Z',
        estado: 'ganada',
        origen: 'humano',
        cliente: { nombre: 'Ana Pérez' },
        lineas: [{ nombre: 'Set 600 hilos king', cantidad: 16, subtotal: 500000, grupo: 'hogar' }],
        totales: { subtotal: 500000, ahorro: 0, iva: 65000, total: 565000 },
      },
    ];
    resultadoLista = { data: filas, error: null };

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T12:00:00Z'));
    try {
      const { calcularMetricas } = await import('@/lib/cotizador/metricas');
      const esperado = calcularMetricas(filas as never, new Date());

      const res = await postMetricas(peticion('http://localhost/api/cotizacion/metricas', { clave: 'secreta' }));
      expect(res.status).toBe(200);
      const cuerpo = await res.json();
      expect(cuerpo.metricas).toEqual(JSON.parse(JSON.stringify(esperado)));
    } finally {
      vi.useRealTimers();
    }
  });

  // Ronda de correcciones 1 (mutante sobreviviente): que /metricas NO filtre
  // por estado es su decisión central —el criterio de qué cuenta vive en
  // `calcularMetricas`, no acá, para que los dos no se desalineen— y no
  // había ninguna prueba que lo protegiera.
  it('no filtra por estado en la consulta: el criterio es de calcularMetricas, no de la ruta', async () => {
    resultadoLista = { data: [], error: null };
    await postMetricas(peticion('http://localhost/api/cotizacion/metricas', { clave: 'secreta' }));
    expect(filtrosSelect).toEqual([]);
  });

  // Ronda de correcciones 1 (hallazgo importante): sin un tope explícito,
  // PostgREST trunca en silencio y sin `order` el corte cae en orden
  // arbitrario.
  it('pide un tope explícito de filas', async () => {
    resultadoLista = { data: [], error: null };
    await postMetricas(peticion('http://localhost/api/cotizacion/metricas', { clave: 'secreta' }));
    expect(limitesSeleccionados).toHaveLength(1);
    expect(limitesSeleccionados[0]).toBeGreaterThanOrEqual(1000);
  });

  it('funciona por cookie de sesión, sin exigir el token anti-CSRF', async () => {
    resultadoLista = { data: [], error: null };
    const { cookie } = emitirSesion();
    const valor = cookie.split(';')[0];
    const res = await postMetricas(peticion('http://localhost/api/cotizacion/metricas', {}, { cookie: valor }));
    expect(res.status).toBe(200);
  });

  it('errores de base dan 500 con mensaje genérico', async () => {
    resultadoLista = { data: null, error: { message: 'la base está caída' } };
    const res = await postMetricas(peticion('http://localhost/api/cotizacion/metricas', { clave: 'secreta' }));
    expect(res.status).toBe(500);
    const cuerpo = await res.json();
    expect(cuerpo.error).not.toContain('la base está caída');
  });
});

describe('POST /api/cotizacion/cerrar', () => {
  it('rechaza sin credencial', async () => {
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { clave: 'otra', id: ID_VALIDO, estado: 'ganada' }),
    );
    expect(res.status).toBe(401);
  });

  it('marca ganada con cerrada_at', async () => {
    resultadoActualizacionConSelect = { data: [{ id: ID_VALIDO }], error: null };
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { clave: 'secreta', id: ID_VALIDO, estado: 'ganada' }),
    );
    expect(res.status).toBe(200);
    expect(actualizaciones).toHaveLength(1);
    const cambios = actualizaciones[0] as Record<string, unknown>;
    expect(cambios.estado).toBe('ganada');
    expect(typeof cambios.cerrada_at).toBe('string');
    expect(filtrosUpdate).toContainEqual(['eq', 'id', ID_VALIDO]);
  });

  it('marca perdida guardando el motivo_cierre', async () => {
    resultadoActualizacionConSelect = { data: [{ id: ID_VALIDO }], error: null };
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', {
        clave: 'secreta',
        id: ID_VALIDO,
        estado: 'perdida',
        motivo: 'Escogió a otro proveedor.',
      }),
    );
    expect(res.status).toBe(200);
    const cambios = actualizaciones[0] as Record<string, unknown>;
    expect(cambios.estado).toBe('perdida');
    expect(cambios.motivo_cierre).toBe('Escogió a otro proveedor.');
    expect(typeof cambios.cerrada_at).toBe('string');
  });

  // Ronda de correcciones 1 (mutante sobreviviente): que 'ganada' NO escriba
  // motivo no estaba probado.
  it('ganada no escribe motivo_cierre', async () => {
    resultadoActualizacionConSelect = { data: [{ id: ID_VALIDO }], error: null };
    await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { clave: 'secreta', id: ID_VALIDO, estado: 'ganada' }),
    );
    const cambios = actualizaciones[0] as Record<string, unknown>;
    expect(cambios).not.toHaveProperty('motivo_cierre');
  });

  it('rechaza un estado que no sea ganada ni perdida', async () => {
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { clave: 'secreta', id: ID_VALIDO, estado: 'enviada' }),
    );
    expect(res.status).toBe(400);
    expect(actualizaciones).toHaveLength(0);
  });

  it('rechaza un id que no es UUID, sin llegar a tocar la base', async () => {
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { clave: 'secreta', id: 'cot-1', estado: 'ganada' }),
    );
    expect(res.status).toBe(400);
    expect(actualizaciones).toHaveLength(0);
  });

  it('rechaza sin token anti-CSRF cuando se entra por cookie', async () => {
    const { cookie } = emitirSesion();
    const valor = cookie.split(';')[0];
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { id: ID_VALIDO, estado: 'ganada' }, { cookie: valor }),
    );
    expect(res.status).toBe(401);
    expect(actualizaciones).toHaveLength(0);
  });

  it('con cookie y el token anti-CSRF correcto, pasa', async () => {
    resultadoActualizacionConSelect = { data: [{ id: ID_VALIDO }], error: null };
    const { cookie, csrf } = emitirSesion();
    const valor = cookie.split(';')[0];
    const res = await postCerrar(
      peticion(
        'http://localhost/api/cotizacion/cerrar',
        { id: ID_VALIDO, estado: 'ganada' },
        { cookie: valor, 'x-csrf-token': csrf },
      ),
    );
    expect(res.status).toBe(200);
  });

  // Hallazgo crítico de esta ronda: cerrar un borrador del agente (o
  // cualquier fila fuera de creada/enviada/error) rompe las métricas porque
  // `totales.total` no existe en un borrador.
  it('rechaza cerrar una cotización que no está en un estado cerrable (ej. un borrador)', async () => {
    resultadoActualizacionConSelect = { data: [], error: null };
    resultadoFila = { data: { estado: 'borrador' }, error: null };
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { clave: 'secreta', id: ID_VALIDO, estado: 'ganada' }),
    );
    expect(res.status).toBe(409);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(false);
    expect(cuerpo.error).toContain('borrador');
  });

  // Mismo mecanismo que arriba: recerrar una cotización ya 'ganada'/'perdida'
  // ya no encuentra fila que actualizar (esos estados no están en
  // `ESTADOS_CERRABLES`), así que `cerrada_at` no se puede volver a pisar
  // con la fecha de un reclic.
  it('rechaza recerrar una cotización que ya está ganada o perdida', async () => {
    resultadoActualizacionConSelect = { data: [], error: null };
    resultadoFila = { data: { estado: 'ganada' }, error: null };
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { clave: 'secreta', id: ID_VALIDO, estado: 'perdida' }),
    );
    expect(res.status).toBe(409);
    const cuerpo = await res.json();
    expect(cuerpo.error).toContain('ganada');
  });

  it('devuelve 404 si el id no existe', async () => {
    resultadoActualizacionConSelect = { data: [], error: null };
    resultadoFila = { data: null, error: null };
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { clave: 'secreta', id: ID_INEXISTENTE, estado: 'ganada' }),
    );
    expect(res.status).toBe(404);
  });

  it('errores de base dan 500 con mensaje genérico', async () => {
    resultadoActualizacionConSelect = { data: null, error: { message: 'la base está caída' } };
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { clave: 'secreta', id: ID_VALIDO, estado: 'ganada' }),
    );
    expect(res.status).toBe(500);
    const cuerpo = await res.json();
    expect(cuerpo.error).not.toContain('la base está caída');
  });
});

const filaReenviable = {
  id: ID_VALIDO,
  numero: 'COT-2026-0001',
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
  totales: { subtotal: 500000, ahorro: 0, iva: 65000, total: 565000 },
  created_at: new Date().toISOString(),
  pdf_ruta: '2026/COT-2026-0001-cot-1.pdf',
};

describe('POST /api/cotizacion/reenviar', () => {
  it('rechaza sin credencial', async () => {
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'otra', id: ID_VALIDO }),
    );
    expect(res.status).toBe(401);
  });

  it('rechaza un id que no es UUID, sin llegar a tocar la base', async () => {
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: 'cot-1' }),
    );
    expect(res.status).toBe(400);
    expect(enviarCotizacion).not.toHaveBeenCalled();
  });

  it('vuelve a firmar el enlace y a mandar el correo', async () => {
    resultadoFila = { data: filaReenviable, error: null };
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_VALIDO }),
    );
    expect(res.status).toBe(200);
    expect(enlaceFirmado).toHaveBeenCalledWith(filaReenviable.pdf_ruta, expect.anything());
    expect(enviarCotizacion).toHaveBeenCalledTimes(1);
    const [params] = vi.mocked(enviarCotizacion).mock.calls[0];
    expect(params.numero).toBe('COT-2026-0001');
    expect(params.cliente.email).toBe('ana@hotel.com');
    expect(params.enlace).toBe('https://firmada');
  });

  it('actualiza resend_id y estado a enviada, pero nunca pisa enviado_at', async () => {
    resultadoFila = { data: filaReenviable, error: null };
    await postReenviar(peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_VALIDO }));
    expect(actualizaciones).toHaveLength(1);
    const cambios = actualizaciones[0] as Record<string, unknown>;
    expect(cambios.resend_id).toBe('re_9');
    expect(cambios.estado).toBe('enviada');
    // `enviado_at` define la vigencia que usan las métricas: pisarlo con la
    // fecha del reenvío las falsea (una cotización vencida de hace 40 días
    // volvería a verse "fresca").
    expect(cambios).not.toHaveProperty('enviado_at');
    expect(filtrosUpdate).toContainEqual(['eq', 'id', ID_VALIDO]);
  });

  it('falla claro si la fila no tiene pdf_ruta: no hay nada que reenviar', async () => {
    resultadoFila = { data: { ...filaReenviable, pdf_ruta: null }, error: null };
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_VALIDO }),
    );
    expect(res.status).toBe(400);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(false);
    expect(cuerpo.error.toLowerCase()).toContain('pdf');
    expect(enviarCotizacion).not.toHaveBeenCalled();
    expect(actualizaciones).toHaveLength(0);
  });

  it('rechaza sin token anti-CSRF cuando se entra por cookie', async () => {
    resultadoFila = { data: filaReenviable, error: null };
    const { cookie } = emitirSesion();
    const valor = cookie.split(';')[0];
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { id: ID_VALIDO }, { cookie: valor }),
    );
    expect(res.status).toBe(401);
    expect(enviarCotizacion).not.toHaveBeenCalled();
  });

  it('cotización no encontrada da un error, no una excepción', async () => {
    resultadoFila = { data: null, error: null };
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_INEXISTENTE }),
    );
    expect(res.status).toBe(404);
  });

  // Ronda de correcciones 1 (mutante sobreviviente): borrar la rama entera
  // del fallo de Resend dejaba las pruebas en verde. `/reenviar` no es
  // idempotente-a-medias como `POST /api/cotizacion` (que ya dejó la
  // cotización creada aunque el correo falle): acá, si el correo falla, no
  // pasó nada — por eso es un error HTTP real y la fila no se toca.
  it('si Resend falla, responde 502 y no actualiza la fila', async () => {
    resultadoFila = { data: filaReenviable, error: null };
    vi.mocked(enviarCotizacion).mockResolvedValueOnce({ ok: false, error: 'Resend 500: caído' });
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_VALIDO }),
    );
    expect(res.status).toBe(502);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(false);
    expect(cuerpo.error).not.toContain('caído');
    expect(actualizaciones).toHaveLength(0);
  });

  it('avisa vencida: true cuando el precio del PDF ya no corre', async () => {
    const haceCuarentaDias = new Date();
    haceCuarentaDias.setDate(haceCuarentaDias.getDate() - 40);
    resultadoFila = { data: { ...filaReenviable, created_at: haceCuarentaDias.toISOString() }, error: null };
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_VALIDO }),
    );
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.vencida).toBe(true);
  });

  it('avisa vencida: false cuando el precio todavía corre', async () => {
    resultadoFila = { data: { ...filaReenviable, created_at: new Date().toISOString() }, error: null };
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_VALIDO }),
    );
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.vencida).toBe(false);
  });
});
