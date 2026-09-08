// tests/campanas-api-lectura.test.ts
//
// Las cinco rutas de sólo lectura de la bandeja de campañas: /zonas,
// /contactos, /plantillas, /previsualizar y /listado. Mismo criterio que
// tests/api-cotizacion-aprobacion.test.ts y tests/equipo-api.test.ts: una
// cookie VÁLIDA de verdad (`emitirSesion`), y sólo se hace diferir la FILA
// de `usuarios_panel` -- porque la promesa central de estas rutas es que
// `autorizarSuperadmin` relee la base y nunca confía en el rol de la
// cookie.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type FilaUsuario = { id: string; rol: 'vendedor' | 'superadmin'; activo: boolean };
let usuarios: FilaUsuario[];
type FilaCampana = { id: string; plantilla: string; asunto: string; creado_por: string; creado_at: string };
type FilaEnvio = { id: string; campana_id: string; estado: 'pendiente' | 'enviado' | 'error' };
let campanas: FilaCampana[];
let envios: FilaEnvio[];

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

function nodoCampanasEnvios(): any {
  const filtros: [string, unknown][] = [];
  let esConteo = false;
  const nodo: any = {
    select(_c: string, opciones?: { head?: boolean }) {
      esConteo = Boolean(opciones?.head);
      return nodo;
    },
    eq(c: string, v: unknown) {
      filtros.push([c, v]);
      return nodo;
    },
    then(resolve: any, reject: any) {
      return (async () => {
        if (!esConteo) throw new Error('doble incompleto');
        const campanaId = filtros.find(([c]) => c === 'campana_id')?.[1];
        const estado = filtros.find(([c]) => c === 'estado')?.[1];
        const n = envios.filter((e) => e.campana_id === campanaId && (estado === undefined || e.estado === estado)).length;
        return { count: n, error: null };
      })().then(resolve, reject);
    },
  };
  return nodo;
}

function nodoCampanas(): any {
  const nodo: any = {
    select() {
      return nodo;
    },
    order() {
      return (async () => ({
        data: [...campanas].sort((a, b) => (a.creado_at < b.creado_at ? 1 : -1)),
        error: null,
      }))();
    },
  };
  return nodo;
}

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      if (tabla === 'usuarios_panel') return nodoUsuarios();
      if (tabla === 'campanas_envios') return nodoCampanasEnvios();
      if (tabla === 'campanas') return nodoCampanas();
      throw new Error(`tabla no mockeada: ${tabla}`);
    },
  }),
}));

const { POST: postZonas } = await import('@/app/api/campanas/zonas/route');
const { POST: postContactos } = await import('@/app/api/campanas/contactos/route');
const { POST: postPlantillas } = await import('@/app/api/campanas/plantillas/route');
const { POST: postPrevisualizar } = await import('@/app/api/campanas/previsualizar/route');
const { POST: postListado } = await import('@/app/api/campanas/listado/route');
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
  return new Request('https://luxeessentialscr.com/api/campanas', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabeceras },
    body: JSON.stringify(cuerpo),
  });
}

function respuestaGhl(contactos: { id: string; firstName?: string; email?: string }[]) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ contacts: contactos }) } as unknown as Response;
}

beforeEach(() => {
  process.env.LUXE_SESION_SECRETO = 'secreta';
  process.env.LUXE_GHL_API_KEY = 'llave-ghl';
  process.env.LUXE_GHL_LOCATION_ID = 'loc-1';
  process.env.LUXE_BAJA_SECRETO = 'secreta-baja';
  usuarios = [
    { id: ID_SUPERADMIN, rol: 'superadmin', activo: true },
    { id: ID_VENDEDOR, rol: 'vendedor', activo: true },
  ];
  campanas = [];
  envios = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/campanas/zonas', () => {
  it('rechaza sin sesión (401)', async () => {
    const res = await postZonas(peticion({}));
    expect(res.status).toBe(401);
  });

  it('rechaza (403) a un vendedor de verdad, aunque la cookie diga superadmin', async () => {
    const { cookie, csrf } = emitirSesion('Guillermo Rojas', 'superadmin', ID_VENDEDOR);
    const res = await postZonas(peticion({}, { cookie: cookie.split(';')[0], 'x-csrf-token': csrf }));
    expect(res.status).toBe(403);
  });

  it('no exige csrf (ruta de sólo lectura)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respuestaGhl([]));
    const { cookie } = sesionSuperadmin();
    const res = await postZonas(peticion({}, { cookie }));
    expect(res.status).toBe(200);
  });

  it('trae las 13 zonas con su conteo, en el orden de ZONAS_COMERCIALES', async () => {
    const fetchImpl = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opciones: any) => {
      const cuerpo = JSON.parse(opciones.body);
      const zona = cuerpo.filters[0].value;
      if (zona === 'Guanacaste Interior') {
        return respuestaGhl(
          Array.from({ length: 27 }, (_, i) => ({ id: `c-${i}`, email: i < 20 ? `a${i}@x.cr` : undefined })),
        );
      }
      return respuestaGhl([]);
    });
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postZonas(peticion({}, { cookie, 'x-csrf-token': csrf }));
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.zonas).toHaveLength(13);
    expect(cuerpo.zonas[0].zona).toBe('GAM Oeste');
    expect(cuerpo.zonas[12].zona).toBe('Revisión manual');
    const gi = cuerpo.zonas.find((z: any) => z.zona === 'Guanacaste Interior');
    expect(gi).toEqual({ zona: 'Guanacaste Interior', total: 27, conCorreo: 20 });
    expect(fetchImpl).toHaveBeenCalledTimes(13);
  });

  it('el fallo de UNA zona no tumba a las otras -- vuelve con error y conteo en cero, sólo esa', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opciones: any) => {
      const cuerpo = JSON.parse(opciones.body);
      if (cuerpo.filters[0].value === 'Caribe') {
        return { ok: false, status: 500, text: async () => 'boom' } as unknown as Response;
      }
      return respuestaGhl([]);
    });
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postZonas(peticion({}, { cookie, 'x-csrf-token': csrf }));
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.zonas).toHaveLength(13);
    const caribe = cuerpo.zonas.find((z: any) => z.zona === 'Caribe');
    expect(caribe.total).toBe(0);
    expect(caribe.error).toBeDefined();
    const otra = cuerpo.zonas.find((z: any) => z.zona === 'GAM Oeste');
    expect(otra.error).toBeUndefined();
  });
});

describe('POST /api/campanas/contactos', () => {
  it('rechaza sin sesión (401)', async () => {
    const res = await postContactos(peticion({ zona: 'GAM Oeste' }));
    expect(res.status).toBe(401);
  });

  it('400 con una zona que no existe', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postContactos(peticion({ zona: 'Marte' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(400);
  });

  it('trae la zona entera, con quien tiene correo y quien no', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respuestaGhl([
        { id: 'c-1', firstName: 'Ana Rodríguez', email: 'ana@hotel.com' },
        { id: 'c-2', firstName: 'Hotel Sin Correo' },
      ]),
    );
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postContactos(peticion({ zona: 'GAM Oeste' }, { cookie, 'x-csrf-token': csrf }));
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.contactos).toHaveLength(2);
    expect(cuerpo.total).toBe(2);
    expect(cuerpo.conCorreo).toBe(1);
    expect(cuerpo.contactos.find((c: any) => c.contactId === 'c-2').correo).toBeNull();
  });

  it('502 si GHL falla', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' } as unknown as Response);
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postContactos(peticion({ zona: 'GAM Oeste' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(502);
  });
});

describe('POST /api/campanas/plantillas', () => {
  it('rechaza sin sesión (401)', async () => {
    const res = await postPlantillas(peticion({}));
    expect(res.status).toBe(401);
  });

  it('trae las 4 plantillas con sus párrafos ya extraídos, sin html', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postPlantillas(peticion({}, { cookie, 'x-csrf-token': csrf }));
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.plantillas).toHaveLength(4);
    for (const p of cuerpo.plantillas) {
      expect(p.html).toBeUndefined();
      expect(Array.isArray(p.parrafos)).toBe(true);
      expect(p.parrafos.length).toBeGreaterThan(0);
      expect(typeof p.asunto).toBe('string');
    }
  });
});

describe('POST /api/campanas/previsualizar', () => {
  it('rechaza sin sesión (401)', async () => {
    const res = await postPrevisualizar(
      peticion({ plantilla: 'inicial', parrafos: ['a', 'b', 'c'], destinatario: { nombreCrm: 'Ana', correo: 'a@x.cr' } }),
    );
    expect(res.status).toBe(401);
  });

  it('400 si el número de párrafos no coincide con la plantilla', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postPrevisualizar(
      peticion(
        { plantilla: 'inicial', parrafos: ['sólo uno'], destinatario: { nombreCrm: 'Ana', correo: 'a@x.cr' } },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    expect(res.status).toBe(400);
  });

  it('devuelve el html renderizado con el nombre, la empresa y el enlace de baja del destinatario', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postPrevisualizar(
      peticion(
        {
          plantilla: 'inicial',
          parrafos: ['Primero.', 'Segundo.', 'Tercero.'],
          destinatario: { nombreCrm: 'Ana Rodríguez', correo: 'ana@hotel.com' },
        },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.html).toContain('Ana');
    expect(cuerpo.html).toContain('Primero.');
    expect(cuerpo.html).toContain('/baja?t=');
    expect(cuerpo.html).not.toContain('{{nombre}}');
    expect(cuerpo.html).not.toContain('{{unsubscribe_url}}');
  });

  it('el saludo no se personaliza para un nombre de negocio', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postPrevisualizar(
      peticion(
        {
          plantilla: 'inicial',
          parrafos: ['Primero.', 'Segundo.', 'Tercero.'],
          destinatario: { nombreCrm: 'supermercado poval', correo: 'facturas@poval.cr' },
        },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    const cuerpo = await res.json();
    expect(cuerpo.html).toContain('Buenos d&iacute;as:');
  });
});

describe('POST /api/campanas/listado', () => {
  it('rechaza sin sesión (401)', async () => {
    const res = await postListado(peticion({}));
    expect(res.status).toBe(401);
  });

  it('devuelve las campañas con su progreso', async () => {
    campanas = [{ id: 'c1', plantilla: 'inicial', asunto: 'Asunto', creado_por: 'Ana', creado_at: '2026-01-01T00:00:00Z' }];
    envios = [
      { id: 'e1', campana_id: 'c1', estado: 'enviado' },
      { id: 'e2', campana_id: 'c1', estado: 'pendiente' },
    ];
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postListado(peticion({}, { cookie, 'x-csrf-token': csrf }));
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.campanas).toHaveLength(1);
    expect(cuerpo.campanas[0].progreso).toEqual({ total: 2, enviados: 1, fallidos: 0, pendientes: 1 });
  });
});
