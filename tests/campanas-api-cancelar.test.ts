// tests/campanas-api-cancelar.test.ts
//
// POST /api/campanas/cancelar (punto 1 del encargo). Mismo criterio de dos
// niveles que el resto de tests/campanas-api-*.test.ts: la lógica de fondo
// (idempotencia, "no existe") ya está probada en tests/campanas-envio.test.ts
// (`cancelarCampana`) -- acá sólo importa la CÁSCARA: autenticación, csrf,
// autorización, y que la ruta traduzca el resultado sin inventar nada.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type FilaUsuario = { id: string; rol: 'vendedor' | 'superadmin'; activo: boolean };
let usuarios: FilaUsuario[];
type FilaCampana = { id: string; cancelada_at: string | null; cancelada_por: string | null };
let campanas: FilaCampana[];

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

function nodoCampanas(): any {
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
      const fila = campanas.find((c) => c.id === idPedido);
      return { data: fila ?? null, error: null };
    },
    update: (cambios: Partial<FilaCampana>) => ({
      eq: async (_c: string, v: unknown) => {
        const fila = campanas.find((c) => c.id === v);
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
      if (tabla === 'campanas') return nodoCampanas();
      throw new Error(`tabla no mockeada: ${tabla}`);
    },
  }),
}));

const { POST: postCancelar } = await import('@/app/api/campanas/cancelar/route');
const { emitirSesion } = await import('@/lib/sesion');

const ID_SUPERADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_VENDEDOR = 'aaaaaaaa-0000-4000-8000-000000000002';

function sesionSuperadmin() {
  const { cookie, csrf } = emitirSesion('Ana Solano', 'superadmin', ID_SUPERADMIN);
  return { cookie: cookie.split(';')[0], csrf };
}

function peticion(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return new Request('https://luxeessentialscr.com/api/campanas/cancelar', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabeceras },
    body: JSON.stringify(cuerpo),
  });
}

beforeEach(() => {
  process.env.LUXE_SESION_SECRETO = 'secreta';
  usuarios = [
    { id: ID_SUPERADMIN, rol: 'superadmin', activo: true },
    { id: ID_VENDEDOR, rol: 'vendedor', activo: true },
  ];
  campanas = [{ id: 'camp-1', cancelada_at: null, cancelada_por: null }];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('autenticación y autorización', () => {
  it('rechaza sin sesión (401)', async () => {
    const res = await postCancelar(peticion({ campanaId: 'camp-1' }));
    expect(res.status).toBe(401);
  });

  it('rechaza (401) una sesión válida sin el token anti-CSRF -- ruta que escribe', async () => {
    const { cookie } = sesionSuperadmin();
    const res = await postCancelar(peticion({ campanaId: 'camp-1' }, { cookie }));
    expect(res.status).toBe(401);
  });

  it('rechaza (403) a un vendedor de verdad, aunque la cookie diga superadmin -- y no cancela nada', async () => {
    const { cookie, csrf } = emitirSesion('Guillermo Rojas', 'superadmin', ID_VENDEDOR);
    const res = await postCancelar(
      peticion({ campanaId: 'camp-1' }, { cookie: cookie.split(';')[0], 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(403);
    expect(campanas[0].cancelada_at).toBeNull();
  });
});

describe('validación', () => {
  it('400 sin campanaId', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCancelar(peticion({}, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(400);
  });
});

describe('camino feliz', () => {
  it('cancela la campaña y queda registrado quién la canceló', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCancelar(peticion({ campanaId: 'camp-1' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo).toEqual({ ok: true, yaEstabaCancelada: false });
    expect(campanas[0].cancelada_at).not.toBeNull();
    expect(campanas[0].cancelada_por).toBe('Ana Solano');
  });

  it('cancelar una ya cancelada no es un error -- yaEstabaCancelada:true', async () => {
    campanas[0].cancelada_at = '2026-01-01T00:00:00.000Z';
    campanas[0].cancelada_por = 'Beto';
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCancelar(peticion({ campanaId: 'camp-1' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo).toEqual({ ok: true, yaEstabaCancelada: true });
    // No pisa quién la había cancelado la primera vez.
    expect(campanas[0].cancelada_por).toBe('Beto');
  });

  it('404 si la campaña no existe', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCancelar(peticion({ campanaId: 'camp-inexistente' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(404);
  });
});
