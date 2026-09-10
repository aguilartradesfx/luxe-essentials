// tests/campanas-api-programado.test.ts
//
// POST /api/campanas/programado (leer el interruptor) y
// POST /api/campanas/programado/pausar (tocarlo) -- encargo, punto 6: "un
// interruptor para parar todo, sin necesidad de desplegar; que sea
// evidente en la pantalla si está parado". Mismo criterio de dos niveles
// que el resto de tests/campanas-api-*.test.ts: la lógica de fondo
// (fallar cerrado sin fila, etc.) se prueba a fondo en
// tests/campanas-programado.test.ts (`estaPausado`/`estadoProgramado`/
// `establecerPausado`) -- acá sólo importa la CÁSCARA: autenticación, csrf,
// autorización, validación, y que las rutas traduzcan el resultado sin
// inventar nada.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type FilaUsuario = { id: string; rol: 'vendedor' | 'superadmin'; activo: boolean };
let usuarios: FilaUsuario[];
type FilaConfig = { id: number; pausado: boolean; pausado_por: string | null; pausado_at: string | null };
let config: FilaConfig[];

function nodoUsuarios(): any {
  const filtros: [string, unknown][] = [];
  const nodo: any = {
    select() {
      return nodo;
    },
    eq(c: string, v: unknown) {
      filtros.push([c, v]);
      return nodo;
    },
    maybeSingle: async () => {
      const m = usuarios.filter((u) => filtros.every(([c, v]) => (u as any)[c] === v));
      return { data: m[0] ?? null, error: null };
    },
  };
  return nodo;
}

function nodoConfig(): any {
  const filtros: [string, unknown][] = [];
  const nodo: any = {
    select() {
      return nodo;
    },
    eq(c: string, v: unknown) {
      filtros.push([c, v]);
      return nodo;
    },
    maybeSingle: async () => {
      const idPedido = filtros.find(([c]) => c === 'id')?.[1];
      const fila = config.find((c) => c.id === idPedido);
      return { data: fila ?? null, error: null };
    },
    update: (cambios: Partial<FilaConfig>) => ({
      eq: async (_c: string, v: unknown) => {
        const fila = config.find((c) => c.id === v);
        if (fila) Object.assign(fila, cambios);
        return { error: null };
      },
    }),
  };
  return nodo;
}

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      if (tabla === 'usuarios_panel') return nodoUsuarios();
      if (tabla === 'campanas_programado_config') return nodoConfig();
      throw new Error(`tabla no mockeada: ${tabla}`);
    },
  }),
}));

const { POST: postEstado } = await import('@/app/api/campanas/programado/route');
const { POST: postPausar } = await import('@/app/api/campanas/programado/pausar/route');
const { emitirSesion } = await import('@/lib/sesion');

const ID_SUPERADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_VENDEDOR = 'aaaaaaaa-0000-4000-8000-000000000002';

function sesionSuperadmin() {
  const { cookie, csrf } = emitirSesion('Ana Solano', 'superadmin', ID_SUPERADMIN);
  return { cookie: cookie.split(';')[0], csrf };
}

function peticion(url: string, cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabeceras },
    body: JSON.stringify(cuerpo),
  });
}

function peticionEstado(cuerpo: unknown = {}, cabeceras: Record<string, string> = {}) {
  return peticion('https://luxeessentialscr.com/api/campanas/programado', cuerpo, cabeceras);
}
function peticionPausar(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return peticion('https://luxeessentialscr.com/api/campanas/programado/pausar', cuerpo, cabeceras);
}

beforeEach(() => {
  process.env.LUXE_SESION_SECRETO = 'secreta';
  usuarios = [
    { id: ID_SUPERADMIN, rol: 'superadmin', activo: true },
    { id: ID_VENDEDOR, rol: 'vendedor', activo: true },
  ];
  config = [{ id: 1, pausado: false, pausado_por: null, pausado_at: null }];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/campanas/programado (leer)', () => {
  it('rechaza sin sesión (401)', async () => {
    const res = await postEstado(peticionEstado());
    expect(res.status).toBe(401);
  });

  it('NO exige csrf -- es de sólo lectura, mismo criterio que /zonas y /plantillas', async () => {
    const { cookie } = sesionSuperadmin();
    const res = await postEstado(peticionEstado({}, { cookie }));
    expect(res.status).toBe(200);
  });

  it('rechaza (403) a un vendedor de verdad, aunque la cookie diga superadmin', async () => {
    const { cookie, csrf } = emitirSesion('Guillermo Rojas', 'superadmin', ID_VENDEDOR);
    const res = await postEstado(peticionEstado({}, { cookie: cookie.split(';')[0], 'x-csrf-token': csrf }));
    expect(res.status).toBe(403);
  });

  it('devuelve pausado:false cuando el interruptor está activo', async () => {
    const { cookie } = sesionSuperadmin();
    const res = await postEstado(peticionEstado({}, { cookie }));
    const cuerpo = await res.json();
    expect(cuerpo).toEqual({ ok: true, pausado: false, pausadoPor: null, pausadoAt: null });
  });

  it('devuelve quién y cuándo pausó, cuando está pausado', async () => {
    config[0] = { id: 1, pausado: true, pausado_por: 'Beto', pausado_at: '2026-09-01T12:00:00.000Z' };
    const { cookie } = sesionSuperadmin();
    const res = await postEstado(peticionEstado({}, { cookie }));
    const cuerpo = await res.json();
    expect(cuerpo).toEqual({ ok: true, pausado: true, pausadoPor: 'Beto', pausadoAt: '2026-09-01T12:00:00.000Z' });
  });

  // Falla cerrado (mismo criterio que `estaPausado`): si la fila no existe
  // -- no debería pasar tras la migración 0027, pero por si acaso -- la
  // ruta informa PAUSADO, nunca activo por defecto.
  it('si la fila del interruptor no existe, informa pausado:true (falla cerrado)', async () => {
    config = [];
    const { cookie } = sesionSuperadmin();
    const res = await postEstado(peticionEstado({}, { cookie }));
    const cuerpo = await res.json();
    expect(cuerpo.pausado).toBe(true);
  });
});

describe('POST /api/campanas/programado/pausar (escribir)', () => {
  it('rechaza sin sesión (401)', async () => {
    const res = await postPausar(peticionPausar({ pausado: true }));
    expect(res.status).toBe(401);
  });

  it('rechaza (401) una sesión válida sin el token anti-CSRF -- ruta que escribe', async () => {
    const { cookie } = sesionSuperadmin();
    const res = await postPausar(peticionPausar({ pausado: true }, { cookie }));
    expect(res.status).toBe(401);
  });

  it('rechaza (403) a un vendedor de verdad, aunque la cookie diga superadmin -- y no toca el interruptor', async () => {
    const { cookie, csrf } = emitirSesion('Guillermo Rojas', 'superadmin', ID_VENDEDOR);
    const res = await postPausar(
      peticionPausar({ pausado: true }, { cookie: cookie.split(';')[0], 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(403);
    expect(config[0].pausado).toBe(false);
  });

  it('400 sin "pausado" (o con un valor que no es booleano)', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postPausar(peticionPausar({}, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(400);
  });

  it('pausa el envío programado y registra quién y cuándo', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postPausar(peticionPausar({ pausado: true }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo).toEqual({ ok: true, pausado: true });
    expect(config[0].pausado).toBe(true);
    expect(config[0].pausado_por).toBe('Ana Solano');
    expect(config[0].pausado_at).not.toBeNull();
  });

  it('reanuda el envío programado (pausado: false)', async () => {
    config[0] = { id: 1, pausado: true, pausado_por: 'Beto', pausado_at: '2026-09-01T12:00:00.000Z' };
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postPausar(peticionPausar({ pausado: false }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(200);
    expect(config[0].pausado).toBe(false);
    // Se sigue registrando quién y cuándo REANUDÓ, no sólo quién pausó --
    // mata al mutante que sólo escribiera pausado_por/pausado_at cuando
    // `pausado` es `true`.
    expect(config[0].pausado_por).toBe('Ana Solano');
  });
});
