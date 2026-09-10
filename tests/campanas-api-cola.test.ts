// tests/campanas-api-cola.test.ts
//
// POST /api/campanas/cola -- la cáscara: autoriza superadmin de verdad
// (releído de la base, mismo criterio que TODA app/api/campanas/*) y
// traduce lo que devuelve `estadoColaProgramada`. La lógica de fondo
// (orden real de zonas, direcciones únicas, rampa, cupo de hoy, fecha
// estimada) ya está probada a fondo en tests/campanas-cola.test.ts --
// `estadoColaProgramada` se MOCKEA acá a propósito, mismo patrón que
// tests/campanas-api-cron.test.ts con `ejecutarEnvioProgramado`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type FilaUsuario = { id: string; rol: 'vendedor' | 'superadmin'; activo: boolean };
let usuarios: FilaUsuario[];

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

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      if (tabla === 'usuarios_panel') return nodoUsuarios();
      throw new Error(`tabla no mockeada: ${tabla}`);
    },
  }),
}));

const estadoColaProgramadaMock = vi.fn();
vi.mock('@/lib/campanas/cola', () => ({
  estadoColaProgramada: (...args: unknown[]) => estadoColaProgramadaMock(...args),
}));

const { POST: postCola } = await import('@/app/api/campanas/cola/route');
const { emitirSesion } = await import('@/lib/sesion');

const ID_SUPERADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_VENDEDOR = 'aaaaaaaa-0000-4000-8000-000000000002';

function sesionSuperadmin() {
  const { cookie, csrf } = emitirSesion('Ana Solano', 'superadmin', ID_SUPERADMIN);
  return { cookie: cookie.split(';')[0], csrf };
}
function sesionVendedor() {
  const { cookie, csrf } = emitirSesion('Guillermo Rojas', 'vendedor', ID_VENDEDOR);
  return { cookie: cookie.split(';')[0], csrf };
}

function peticion(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return new Request('https://luxeessentialscr.com/api/campanas/cola', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabeceras },
    body: JSON.stringify(cuerpo),
  });
}

const ESTADO_EJEMPLO = {
  zonas: [{ zona: 'Guanacaste Interior', orden: 1, estado: 'espera', campanaId: null, direccionesTotal: 22, direccionesEnviadas: 0, direccionesFallidas: 0, direccionesPendientes: 22, error: null }],
  totalDirecciones: 22,
  totalEnviadas: 0,
  totalFallidas: 0,
  totalPendientes: 22,
  cupoHoy: { dia: 1, tope: 25, reservado: 0, disponible: 25, diaHabilHoy: true },
  fechaEstimadaFin: '2026-09-09',
  totalIncompleto: false,
  zonasConError: [] as string[],
};

beforeEach(() => {
  process.env.LUXE_SESION_SECRETO = 'secreta';
  process.env.LUXE_GHL_API_KEY = 'llave-ghl';
  process.env.LUXE_GHL_LOCATION_ID = 'loc-1';
  usuarios = [
    { id: ID_SUPERADMIN, rol: 'superadmin', activo: true },
    { id: ID_VENDEDOR, rol: 'vendedor', activo: true },
  ];
  estadoColaProgramadaMock.mockReset();
  estadoColaProgramadaMock.mockResolvedValue(ESTADO_EJEMPLO);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('declara maxDuration', () => {
  it('declara maxDuration >= 30 -- las trece zonas son ~47 peticiones a GHL', async () => {
    const modulo = await import('@/app/api/campanas/cola/route');
    expect(typeof modulo.maxDuration).toBe('number');
    expect(modulo.maxDuration).toBeGreaterThanOrEqual(30);
  });
});

describe('POST /api/campanas/cola', () => {
  it('rechaza sin sesión (401)', async () => {
    const res = await postCola(peticion({}));
    expect(res.status).toBe(401);
    expect(estadoColaProgramadaMock).not.toHaveBeenCalled();
  });

  // La misma decisión que el resto de app/api/campanas/*: esta ruta expone
  // a qué empresas se les va a escribir a continuación, así que exige
  // superadmin RELEÍDO de la base -- una cookie que diga "superadmin" no
  // alcanza si la fila real dice otra cosa.
  it('rechaza (403) a un vendedor de verdad, aunque la cookie diga superadmin', async () => {
    const { cookie, csrf } = emitirSesion('Guillermo Rojas', 'superadmin', ID_VENDEDOR);
    const res = await postCola(peticion({}, { cookie: cookie.split(';')[0], 'x-csrf-token': csrf }));
    expect(res.status).toBe(403);
    expect(estadoColaProgramadaMock).not.toHaveBeenCalled();
  });

  it('rechaza (403) a un vendedor real', async () => {
    const { cookie, csrf } = sesionVendedor();
    const res = await postCola(peticion({}, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(403);
  });

  it('no exige csrf (ruta de sólo lectura)', async () => {
    const { cookie } = sesionSuperadmin();
    const res = await postCola(peticion({}, { cookie }));
    expect(res.status).toBe(200);
  });

  it('a un superadmin le devuelve la cola tal cual la calculó estadoColaProgramada', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCola(peticion({}, { cookie, 'x-csrf-token': csrf }));
    const cuerpo = await res.json();
    expect(res.status).toBe(200);
    expect(cuerpo).toEqual({
      ok: true,
      zonas: ESTADO_EJEMPLO.zonas,
      totales: { direcciones: 22, enviadas: 0, fallidas: 0, pendientes: 22 },
      totalIncompleto: false,
      zonasConError: [],
      cupoHoy: ESTADO_EJEMPLO.cupoHoy,
      fechaEstimadaFin: '2026-09-09',
    });
  });

  // Hallazgo de producción (2026-09-10): si `estadoColaProgramada` marcó
  // alguna zona en error, la ruta tiene que dejarlo pasar tal cual -- nunca
  // esconderlo ni "completar" el total por su cuenta.
  it('deja pasar totalIncompleto/zonasConError tal cual cuando estadoColaProgramada los trae', async () => {
    estadoColaProgramadaMock.mockResolvedValue({
      ...ESTADO_EJEMPLO,
      totalIncompleto: true,
      zonasConError: ['Pacífico Central'],
    });
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCola(peticion({}, { cookie, 'x-csrf-token': csrf }));
    const cuerpo = await res.json();
    expect(cuerpo.totalIncompleto).toBe(true);
    expect(cuerpo.zonasConError).toEqual(['Pacífico Central']);
  });

  it('500 si faltan las credenciales de GHL', async () => {
    delete process.env.LUXE_GHL_API_KEY;
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCola(peticion({}, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(500);
    expect(estadoColaProgramadaMock).not.toHaveBeenCalled();
  });

  it('502 si estadoColaProgramada falla (GHL caído, error de base, etc.)', async () => {
    estadoColaProgramadaMock.mockRejectedValue(new Error('boom'));
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCola(peticion({}, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(502);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(false);
  });
});
