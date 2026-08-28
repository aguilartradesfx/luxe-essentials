import { describe, it, expect, vi, beforeEach } from 'vitest';

// Tarea 8: los cuatro endpoints que consume la pantalla del panel —listar,
// medir, cerrar y reenviar—. Mismo patrón que tests/api-borradores.test.ts:
// Supabase simulado, `Request` armado a mano, sin red.
//
// Ronda de correcciones 1: sumó, además de los casos obligatorios del
// brief, las pruebas que un mutante barato sobrevivía.
// Ronda de correcciones 2: el mock ahora registra los filtros de `.in()` y
// `.order()` (antes solo los de `.eq()`/`.limit()`), porque borrar la
// guarda de estados de `/cerrar` o el `.order()` de `/metricas` dejaba toda
// la suite en verde — nada comprobaba que esos filtros llegaran de verdad a
// la consulta, solo que el código reaccionara bien cuando el mock ya
// devolvía el resultado "correcto" a mano.

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

type Filtro = [string, string, string];

// Estado mutable que cada prueba configura antes de llamar a la ruta. Vive
// fuera del módulo mockeado (es del propio archivo de prueba), igual que
// `filtros` en tests/api-borradores.test.ts.
let resultadoLista: { data: unknown; error: { message: string } | null } = { data: [], error: null };
let resultadoFila: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let resultadoActualizacion: { error: { message: string } | null } = { error: null };
// Resultado por defecto de cualquier `update(...).select(...)`. La mayoría
// de las pruebas solo necesitan esto. `/cerrar` hace DOS intentos de
// `update` en algunos casos (cierre inicial y, si no coincide, corrección);
// las pruebas que necesitan una respuesta distinta para cada intento
// reemplazan `resolverActualizacionConSelect` directamente (ver más abajo).
let resultadoActualizacionConSelect: { data: unknown; error: { message: string } | null } = {
  data: [{ id: ID_VALIDO }],
  error: null,
};
let resolverActualizacionConSelect: (filtrosDeEsteUpdate: Filtro[]) => {
  data: unknown;
  error: { message: string } | null;
} = () => resultadoActualizacionConSelect;
let resultadoDescarga: { data: unknown; error: { message: string } | null } = {
  data: { arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7 falso').buffer },
  error: null,
};

const columnasSeleccionadas: string[] = [];
const filtrosSelect: Filtro[] = [];
const ordenesSeleccionados: [string, boolean][] = [];
const limitesSeleccionados: number[] = [];
const filtrosUpdate: Filtro[] = [];
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
    order: (columna: string, opciones?: { ascending?: boolean }) => {
      ordenesSeleccionados.push([columna, opciones?.ascending ?? true]);
      return construirLectura();
    },
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
// espera /reenviar); con `.select()`, con lo que devuelva
// `resolverActualizacionConSelect` para LOS FILTROS DE ESTE `update` en
// particular (lo que espera /cerrar, que necesita saber si el `update` tocó
// alguna fila, y a veces hace dos intentos con respuestas distintas cada
// uno).
function construirEscritura(cambios: unknown): any {
  actualizaciones.push(cambios);
  const filtrosLocales: Filtro[] = [];
  const nodo: any = {
    eq: (columna: string, valor: string) => {
      const entrada: Filtro = ['eq', columna, String(valor)];
      filtrosUpdate.push(entrada);
      filtrosLocales.push(entrada);
      return nodo;
    },
    in: (columna: string, valores: readonly string[]) => {
      const entrada: Filtro = ['in', columna, valores.join(',')];
      filtrosUpdate.push(entrada);
      filtrosLocales.push(entrada);
      return nodo;
    },
    select: () => Promise.resolve(resolverActualizacionConSelect(filtrosLocales)),
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
  resolverActualizacionConSelect = () => resultadoActualizacionConSelect;
  resultadoDescarga = {
    data: { arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7 falso').buffer },
    error: null,
  };

  columnasSeleccionadas.length = 0;
  filtrosSelect.length = 0;
  ordenesSeleccionados.length = 0;
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

  it('nunca pide más de 200 filas, aunque se pida un límite mayor', async () => {
    resultadoLista = { data: [], error: null };
    await postListado(peticion('http://localhost/api/cotizacion/listado', { clave: 'secreta', limite: 500 }));
    expect(limitesSeleccionados).toEqual([200]);
  });

  // Ronda de correcciones 2: sin esto, quitar el `.order()` del código
  // dejaba la suite en verde igual — nada comprobaba que las más recientes
  // fueran las que se piden primero.
  it('pide las filas más recientes primero', async () => {
    resultadoLista = { data: [], error: null };
    await postListado(peticion('http://localhost/api/cotizacion/listado', { clave: 'secreta' }));
    expect(ordenesSeleccionados).toEqual([['created_at', false]]);
  });

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

  it('no filtra por estado en la consulta: el criterio es de calcularMetricas, no de la ruta', async () => {
    resultadoLista = { data: [], error: null };
    await postMetricas(peticion('http://localhost/api/cotizacion/metricas', { clave: 'secreta' }));
    expect(filtrosSelect).toEqual([]);
  });

  it('pide un tope explícito de filas', async () => {
    resultadoLista = { data: [], error: null };
    await postMetricas(peticion('http://localhost/api/cotizacion/metricas', { clave: 'secreta' }));
    expect(limitesSeleccionados).toHaveLength(1);
    expect(limitesSeleccionados[0]).toBeGreaterThanOrEqual(1000);
  });

  // Ronda de correcciones 2 (hallazgo importante): quitar el `.order()` del
  // código dejaba la prueba del tope de arriba en verde igual — el tope
  // solo protege a las filas más recientes si de verdad son las primeras
  // en la respuesta.
  it('ordena por created_at descendente antes de aplicar el tope', async () => {
    resultadoLista = { data: [], error: null };
    await postMetricas(peticion('http://localhost/api/cotizacion/metricas', { clave: 'secreta' }));
    expect(ordenesSeleccionados).toEqual([['created_at', false]]);
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

  it('marca ganada con cerrada_at, filtrando por los estados de cierre inicial', async () => {
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { clave: 'secreta', id: ID_VALIDO, estado: 'ganada' }),
    );
    expect(res.status).toBe(200);
    expect(actualizaciones).toHaveLength(1);
    const cambios = actualizaciones[0] as Record<string, unknown>;
    expect(cambios.estado).toBe('ganada');
    expect(typeof cambios.cerrada_at).toBe('string');
    expect(filtrosUpdate).toContainEqual(['eq', 'id', ID_VALIDO]);
    // Ronda de correcciones 2 (hallazgo importante): esta es la aserción
    // que faltaba. Borrar el `.in('estado', ESTADOS_CIERRE_INICIAL)` del
    // código dejaba las 37 pruebas de la ronda anterior en verde, porque
    // todas asumían el filtro ya aplicado a través del mock en vez de
    // comprobar que de verdad llegara a la consulta.
    expect(filtrosUpdate).toContainEqual(['in', 'estado', 'creada,enviada,error']);
  });

  it('marca perdida guardando el motivo_cierre', async () => {
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

  it('ganada no escribe motivo_cierre', async () => {
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

  // Ronda de correcciones 2 (decisión de producto): corregir un cierre
  // equivocado (ganada → perdida o viceversa) ahora es posible, sin tocar
  // la base a mano. `resolverActualizacionConSelect` distingue el intento 1
  // (cierre inicial, no coincide porque la fila ya está 'ganada') del
  // intento 2 (corrección, sí coincide).
  it('corrige de ganada a perdida', async () => {
    resolverActualizacionConSelect = (filtrosDeEsteUpdate) => {
      const filtroEstados = filtrosDeEsteUpdate.find(([tipo, columna]) => tipo === 'in' && columna === 'estado');
      const valores = filtroEstados ? filtroEstados[2].split(',') : [];
      if (valores.includes('ganada')) {
        // Intento 2 (corrección): la fila está 'ganada', coincide.
        return { data: [{ id: ID_VALIDO }], error: null };
      }
      // Intento 1 (cierre inicial): la fila no está en creada/enviada/error.
      return { data: [], error: null };
    };

    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', {
        clave: 'secreta',
        id: ID_VALIDO,
        estado: 'perdida',
        motivo: 'Se fue con otro proveedor.',
      }),
    );

    expect(res.status).toBe(200);
    expect(actualizaciones).toHaveLength(2);
    const cambiosCorreccion = actualizaciones[1] as Record<string, unknown>;
    expect(cambiosCorreccion.estado).toBe('perdida');
    expect(cambiosCorreccion.motivo_cierre).toBe('Se fue con otro proveedor.');
    expect(filtrosUpdate).toContainEqual(['in', 'estado', 'ganada,perdida']);
  });

  // La fecha del cierre original es la que le importa a "días promedio
  // hasta cerrar" (lib/cotizador/metricas.ts); una corrección no la mueve.
  it('la corrección conserva la cerrada_at original: no la vuelve a escribir', async () => {
    resolverActualizacionConSelect = (filtrosDeEsteUpdate) => {
      const filtroEstados = filtrosDeEsteUpdate.find(([tipo, columna]) => tipo === 'in' && columna === 'estado');
      const valores = filtroEstados ? filtroEstados[2].split(',') : [];
      return valores.includes('ganada')
        ? { data: [{ id: ID_VALIDO }], error: null }
        : { data: [], error: null };
    };

    await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { clave: 'secreta', id: ID_VALIDO, estado: 'perdida' }),
    );

    const cambiosCorreccion = actualizaciones[1] as Record<string, unknown>;
    expect(cambiosCorreccion).not.toHaveProperty('cerrada_at');
  });

  it('rechaza cerrar un borrador (sin totales confiables)', async () => {
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

  it('rechaza cerrar una fila convertida', async () => {
    resultadoActualizacionConSelect = { data: [], error: null };
    resultadoFila = { data: { estado: 'convertida' }, error: null };
    const res = await postCerrar(
      peticion('http://localhost/api/cotizacion/cerrar', { clave: 'secreta', id: ID_VALIDO, estado: 'ganada' }),
    );
    expect(res.status).toBe(409);
    const cuerpo = await res.json();
    expect(cuerpo.error).toContain('convertida');
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

function filaReenviable(extra: Record<string, unknown> = {}) {
  return {
    id: ID_VALIDO,
    numero: 'COT-2026-0001',
    estado: 'error',
    cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
    totales: { subtotal: 500000, ahorro: 0, iva: 65000, total: 565000 },
    created_at: new Date().toISOString(),
    pdf_ruta: '2026/COT-2026-0001-cot-1.pdf',
    ...extra,
  };
}

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
    resultadoFila = { data: filaReenviable(), error: null };
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_VALIDO }),
    );
    expect(res.status).toBe(200);
    expect(enlaceFirmado).toHaveBeenCalledWith('2026/COT-2026-0001-cot-1.pdf', expect.anything());
    expect(enviarCotizacion).toHaveBeenCalledTimes(1);
    const [params] = vi.mocked(enviarCotizacion).mock.calls[0];
    expect(params.numero).toBe('COT-2026-0001');
    expect(params.cliente.email).toBe('ana@hotel.com');
    expect(params.enlace).toBe('https://firmada');
  });

  it('sana el estado a enviada cuando la fila venía de un envío fallido (error)', async () => {
    resultadoFila = { data: filaReenviable({ estado: 'error' }), error: null };
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

  // Ronda de correcciones 2 (hallazgo importante): antes `estado` pasaba a
  // 'enviada' sin condición. Si ya estaba 'enviada' no hacía daño real, pero
  // tampoco había ninguna prueba que dijera qué se esperaba.
  it('si ya estaba enviada, no vuelve a escribir el estado', async () => {
    resultadoFila = { data: filaReenviable({ estado: 'enviada' }), error: null };
    await postReenviar(peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_VALIDO }));
    const cambios = actualizaciones[0] as Record<string, unknown>;
    expect(cambios).not.toHaveProperty('estado');
  });

  // Ronda de correcciones 2 (hallazgo importante): antes reenviar una
  // cotización ya cerrada la devolvía a 'enviada' — reabría un trato que ya
  // estaba ganado o perdido con solo apretar "Reenviar".
  it('si la cotización ya está ganada, reenviar no la reabre', async () => {
    resultadoFila = { data: filaReenviable({ estado: 'ganada' }), error: null };
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_VALIDO }),
    );
    expect(res.status).toBe(200);
    const cambios = actualizaciones[0] as Record<string, unknown>;
    expect(cambios).not.toHaveProperty('estado');
  });

  it('si la cotización ya está perdida, reenviar no la reabre', async () => {
    resultadoFila = { data: filaReenviable({ estado: 'perdida' }), error: null };
    await postReenviar(peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_VALIDO }));
    const cambios = actualizaciones[0] as Record<string, unknown>;
    expect(cambios).not.toHaveProperty('estado');
  });

  it('falla claro si la fila no tiene pdf_ruta: no hay nada que reenviar', async () => {
    resultadoFila = { data: filaReenviable({ pdf_ruta: null }), error: null };
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
    resultadoFila = { data: filaReenviable(), error: null };
    const { cookie } = emitirSesion();
    const valor = cookie.split(';')[0];
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { id: ID_VALIDO }, { cookie: valor }),
    );
    expect(res.status).toBe(401);
    expect(enviarCotizacion).not.toHaveBeenCalled();
  });

  it('cotización no encontrada da 404, no una excepción', async () => {
    resultadoFila = { data: null, error: null };
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_INEXISTENTE }),
    );
    expect(res.status).toBe(404);
  });

  // Ronda de correcciones 2 (hallazgo importante): `.single()` respondía
  // `error` tanto para "no hay fila" como para una caída real de la base, y
  // las dos ramas caían en el mismo 404 — una caída de la base le aparecía
  // al vendedor como "cotización no encontrada". `.maybeSingle()` separa
  // los dos casos.
  it('un error de base en la consulta inicial da 500, no 404', async () => {
    resultadoFila = { data: null, error: { message: 'la base está caída' } };
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_VALIDO }),
    );
    expect(res.status).toBe(500);
    const cuerpo = await res.json();
    expect(cuerpo.error).not.toContain('la base está caída');
    expect(enviarCotizacion).not.toHaveBeenCalled();
  });

  it('si Resend falla, responde 502 y no actualiza la fila', async () => {
    resultadoFila = { data: filaReenviable(), error: null };
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

  // Ronda de correcciones 2 (hallazgo importante): antes, si el `update`
  // final fallaba, se registraba en el log y la respuesta decía `ok: true`
  // sin avisar nada — el vendedor no tenía forma de saber que el panel
  // podía estar desactualizado.
  it('si el update final falla, la respuesta avisa que el correo salió pero el registro no se actualizó', async () => {
    resultadoFila = { data: filaReenviable(), error: null };
    resultadoActualizacion = { error: { message: 'la base está caída' } };
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_VALIDO }),
    );
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.actualizado).toBe(false);
    expect(typeof cuerpo.avisoActualizacion).toBe('string');
    expect(cuerpo.avisoActualizacion.length).toBeGreaterThan(0);
    expect(cuerpo.avisoActualizacion).not.toContain('la base está caída');
  });

  it('cuando todo sale bien, la respuesta confirma que sí se actualizó', async () => {
    resultadoFila = { data: filaReenviable(), error: null };
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_VALIDO }),
    );
    const cuerpo = await res.json();
    expect(cuerpo.actualizado).toBe(true);
  });

  it('avisa vencida: true cuando el precio del PDF ya no corre', async () => {
    const haceCuarentaDias = new Date();
    haceCuarentaDias.setDate(haceCuarentaDias.getDate() - 40);
    resultadoFila = { data: filaReenviable({ created_at: haceCuarentaDias.toISOString() }), error: null };
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_VALIDO }),
    );
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.vencida).toBe(true);
  });

  it('avisa vencida: false cuando el precio todavía corre', async () => {
    resultadoFila = { data: filaReenviable({ created_at: new Date().toISOString() }), error: null };
    const res = await postReenviar(
      peticion('http://localhost/api/cotizacion/reenviar', { clave: 'secreta', id: ID_VALIDO }),
    );
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.vencida).toBe(false);
  });
});
