import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Tarea 8: los cuatro endpoints que consume la pantalla del panel —listar,
// medir, cerrar y reenviar—. Mismo patrón que tests/api-borradores.test.ts:
// Supabase simulado, `Request` armado a mano, sin red.

vi.mock('@/lib/cotizador/almacen', () => ({
  BUCKET: 'cotizaciones',
  enlaceFirmado: vi.fn().mockResolvedValue({ ok: true, url: 'https://firmada' }),
}));
vi.mock('@/lib/cotizador/correo', () => ({
  enviarCotizacion: vi.fn().mockResolvedValue({ ok: true, resendId: 're_9' }),
}));

// Estado mutable que cada prueba configura antes de llamar a la ruta. Vive
// fuera del módulo mockeado (es del propio archivo de prueba), igual que
// `filtros` en tests/api-borradores.test.ts.
let resultadoLista: { data: unknown; error: { message: string } | null } = { data: [], error: null };
let resultadoFila: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let resultadoActualizacion: { error: { message: string } | null } = { error: null };
let resultadoDescarga: { data: unknown; error: { message: string } | null } = {
  data: { arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7 falso').buffer },
  error: null,
};

const columnasSeleccionadas: string[] = [];
const filtrosSelect: [string, string][] = [];
const filtrosUpdate: [string, string][] = [];
const actualizaciones: unknown[] = [];

// Constructor recursivo: cada método de filtro devuelve otra vez el mismo
// tipo de objeto encadenable, y `limit`/`single` (o el propio `await` sobre
// el objeto, vía `then`) son los puntos donde de verdad se resuelve.
function construirSelect(): any {
  const encadenable: any = {
    eq: (columna: string, valor: string) => {
      filtrosSelect.push([columna, valor]);
      return construirSelect();
    },
    order: () => construirSelect(),
    limit: async () => resultadoLista,
    single: async () => resultadoFila,
    // `/api/cotizacion/metricas` hace `await ....select(columnas)` sin
    // ningún método más: el propio objeto de `select` tiene que ser
    // "thenable" para que ese `await` resuelva solo.
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve(resultadoLista).then(resolve, reject),
  };
  return encadenable;
}

function construirUpdate(cambios: unknown): any {
  actualizaciones.push(cambios);
  return {
    eq: async (columna: string, valor: string) => {
      filtrosUpdate.push([columna, valor]);
      return resultadoActualizacion;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: (columnas: string) => {
        columnasSeleccionadas.push(columnas);
        return construirSelect();
      },
      update: (cambios: unknown) => construirUpdate(cambios),
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
  resultadoDescarga = {
    data: { arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7 falso').buffer },
    error: null,
  };

  columnasSeleccionadas.length = 0;
  filtrosSelect.length = 0;
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
    expect(filtrosSelect).toEqual([['estado', 'enviada']]);
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
      peticion('http://localhost/api/cotizacion/cerrar', { clave: 'otra', id: 'cot-1', estado: 'ganada' }),
    );
    expect(res.status).toBe(401);
  });

  it('marca ganada con cerrada_at', async () => {
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { clave: 'secreta', id: 'cot-1', estado: 'ganada' }),
    );
    expect(res.status).toBe(200);
    expect(actualizaciones).toHaveLength(1);
    const cambios = actualizaciones[0] as Record<string, unknown>;
    expect(cambios.estado).toBe('ganada');
    expect(typeof cambios.cerrada_at).toBe('string');
    expect(filtrosUpdate).toEqual([['id', 'cot-1']]);
  });

  it('marca perdida guardando el motivo_cierre', async () => {
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', {
        clave: 'secreta',
        id: 'cot-1',
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

  it('rechaza un estado que no sea ganada ni perdida', async () => {
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { clave: 'secreta', id: 'cot-1', estado: 'enviada' }),
    );
    expect(res.status).toBe(400);
    expect(actualizaciones).toHaveLength(0);
  });

  it('rechaza sin token anti-CSRF cuando se entra por cookie', async () => {
    const { cookie } = emitirSesion();
    const valor = cookie.split(';')[0];
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { id: 'cot-1', estado: 'ganada' }, { cookie: valor }),
    );
    expect(res.status).toBe(401);
    expect(actualizaciones).toHaveLength(0);
  });

  it('con cookie y el token anti-CSRF correcto, pasa', async () => {
    const { cookie, csrf } = emitirSesion();
    const valor = cookie.split(';')[0];
    const res = await postCerrar(
      peticion(
        'http://localhost/api/cotizacion/cerrar',
        { id: 'cot-1', estado: 'ganada' },
        { cookie: valor, 'x-csrf-token': csrf },
      ),
    );
    expect(res.status).toBe(200);
  });

  it('errores de base dan 500 con mensaje genérico', async () => {
    resultadoActualizacion = { error: { message: 'la base está caída' } };
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { clave: 'secreta', id: 'cot-1', estado: 'ganada' }),
    );
    expect(res.status).toBe(500);
    const cuerpo = await res.json();
    expect(cuerpo.error).not.toContain('la base está caída');
  });
});

const filaReenviable = {
  id: 'cot-1',
  numero: 'COT-2026-0001',
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
  totales: { subtotal: 500000, ahorro: 0, iva: 65000, total: 565000 },
  created_at: '2026-08-01T10:00:00Z',
  pdf_ruta: '2026/COT-2026-0001-cot-1.pdf',
};

describe('POST /api/cotizacion/reenviar', () => {
  it('rechaza sin credencial', async () => {
    const res = await postReenviar(peticion('http://localhost/api/cotizacion/reenviar', { clave: 'otra', id: 'cot-1' }));
    expect(res.status).toBe(401);
  });

  it('vuelve a firmar el enlace y a mandar el correo', async () => {
    resultadoFila = { data: filaReenviable, error: null };
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: 'cot-1' }),
    );
    expect(res.status).toBe(200);
    expect(enlaceFirmado).toHaveBeenCalledWith(filaReenviable.pdf_ruta, expect.anything());
    expect(enviarCotizacion).toHaveBeenCalledTimes(1);
    const [params] = vi.mocked(enviarCotizacion).mock.calls[0];
    expect(params.numero).toBe('COT-2026-0001');
    expect(params.cliente.email).toBe('ana@hotel.com');
    expect(params.enlace).toBe('https://firmada');
  });

  it('actualiza enviado_at y resend_id', async () => {
    resultadoFila = { data: filaReenviable, error: null };
    await postReenviar(peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: 'cot-1' }));
    expect(actualizaciones).toHaveLength(1);
    const cambios = actualizaciones[0] as Record<string, unknown>;
    expect(typeof cambios.enviado_at).toBe('string');
    expect(cambios.resend_id).toBe('re_9');
    expect(filtrosUpdate).toEqual([['id', 'cot-1']]);
  });

  it('falla claro si la fila no tiene pdf_ruta: no hay nada que reenviar', async () => {
    resultadoFila = { data: { ...filaReenviable, pdf_ruta: null }, error: null };
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: 'cot-1' }),
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
      peticion('http://localhost/api/cotizacion/reenviar', { id: 'cot-1' }, { cookie: valor }),
    );
    expect(res.status).toBe(401);
    expect(enviarCotizacion).not.toHaveBeenCalled();
  });

  it('cotización no encontrada da un error, no una excepción', async () => {
    resultadoFila = { data: null, error: null };
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: 'no-existe' }),
    );
    expect(res.status).toBe(404);
  });
});
