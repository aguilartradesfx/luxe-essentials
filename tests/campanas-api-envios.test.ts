// POST /api/campanas/envios: la lista de clientes de la empresa, uno por uno.
// Mismo criterio que tests/campanas-api-lectura.test.ts: cookie VÁLIDA de
// verdad (`emitirSesion`), y sólo se hace diferir la FILA de `usuarios_panel`
// -- la promesa central es que `autorizarSuperadmin` relee la base.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crearDb, envio, uuid, type Datos } from './helpers/db-envios';

type FilaUsuario = { id: string; rol: 'vendedor' | 'superadmin'; activo: boolean };
let usuarios: FilaUsuario[];
let datos: Datos;
let tablasLeidas: string[];

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => {
    const envios = crearDb(datos);
    return {
      from: (tabla: string) => {
        tablasLeidas.push(tabla);
        if (tabla === 'usuarios_panel') {
          const filtros: [string, unknown][] = [];
          const nodo: any = {
            select: () => nodo,
            eq: (c: string, v: unknown) => (filtros.push([c, v]), nodo),
            maybeSingle: async () => ({
              data: usuarios.filter((u) => filtros.every(([c, v]) => (u as any)[c] === v))[0] ?? null,
              error: null,
            }),
          };
          return nodo;
        }
        return envios.from(tabla);
      },
    };
  },
}));

const { POST } = await import('@/app/api/campanas/envios/route');
const { emitirSesion } = await import('@/lib/sesion');
const { _reiniciarCacheAutenticacion } = await import('@/lib/autenticacion-cotizador');

const ID_SUPER = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_VENDEDOR = 'aaaaaaaa-0000-4000-8000-000000000002';
const C1 = uuid(9001);

function peticion(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return new Request('https://luxeessentialscr.com/api/campanas/envios', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabeceras },
    body: JSON.stringify(cuerpo),
  });
}
function cookieDe(nombre: string, rol: 'vendedor' | 'superadmin', id: string) {
  return { cookie: emitirSesion(nombre, rol, id).cookie.split(';')[0] };
}

beforeEach(() => {
  _reiniciarCacheAutenticacion();
  process.env.LUXE_SESION_SECRETO = 'secreta';
  usuarios = [
    { id: ID_SUPER, rol: 'superadmin', activo: true },
    { id: ID_VENDEDOR, rol: 'vendedor', activo: true },
  ];
  datos = {
    campanas: [{ id: C1, zona: 'Zona Norte', plantilla: 'inicial', creado_at: '2026-09-01T10:00:00+00:00' }],
    envios: [envio({ campana_id: C1, correo: 'cliente@empresa.cr' }), envio({ campana_id: C1, entrega_estado: 'rebotado' })],
  };
  tablasLeidas = [];
});

describe('POST /api/campanas/envios -- autorización', () => {
  it('sin sesión: 401, y no toca la tabla de envíos', async () => {
    const res = await POST(peticion({}));
    expect(res.status).toBe(401);
    expect(tablasLeidas).not.toContain('campanas_envios');
  });

  it('un vendedor de verdad: 403, sin una sola fila de clientes en la respuesta', async () => {
    const res = await POST(peticion({}, cookieDe('Guillermo', 'vendedor', ID_VENDEDOR)));
    expect(res.status).toBe(403);
    const texto = await res.text();
    expect(texto).not.toContain('cliente@empresa.cr');
    expect(tablasLeidas).not.toContain('campanas_envios');
  });

  it('cookie que dice superadmin pero la fila real es vendedor: 403 (se relee la base)', async () => {
    const res = await POST(peticion({}, cookieDe('Guillermo', 'superadmin', ID_VENDEDOR)));
    expect(res.status).toBe(403);
    expect(tablasLeidas).not.toContain('campanas_envios');
  });

  it('un superadmin desactivado después de iniciar sesión: 403', async () => {
    usuarios[0].activo = false;
    const res = await POST(peticion({}, cookieDe('Ana', 'superadmin', ID_SUPER)));
    expect([401, 403]).toContain(res.status);
    expect(await res.text()).not.toContain('cliente@empresa.cr');
  });

  it('un superadmin: 200, con sus filas; no exige csrf (sólo lectura)', async () => {
    const res = await POST(peticion({}, cookieDe('Ana', 'superadmin', ID_SUPER)));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.envios).toHaveLength(2);
    expect(cuerpo.total).toBe(2);
  });
});

describe('POST /api/campanas/envios -- filtros', () => {
  const sesion = () => cookieDe('Ana', 'superadmin', ID_SUPER);

  it('aplica el estado pedido y deja fuera el resto', async () => {
    const res = await POST(peticion({ estado: 'rebotado' }, sesion()));
    const cuerpo = await res.json();
    expect(cuerpo.envios).toHaveLength(1);
    expect(cuerpo.envios[0].estado).toBe('rebotado');
  });

  it('aplica la búsqueda', async () => {
    const cuerpo = await (await POST(peticion({ busqueda: 'CLIENTE@' }, sesion()))).json();
    expect(cuerpo.envios.map((e: any) => e.correo)).toEqual(['cliente@empresa.cr']);
  });

  it.each([
    [{ estado: 'spam' }, 'estado'],
    [{ campanaId: 'no-es-uuid' }, 'campaña'],
    [{ zona: 5 }, 'zona'],
    [{ busqueda: 7 }, 'búsqueda'],
    [{ despues: { at: 'mañana', id: uuid(1) } }, 'página'],
    [{ despues: { at: '2026-10-02T15:28:31.714+00:00', id: 'x' } }, 'página'],
  ])('rechaza (400) un filtro inválido %j', async (cuerpoPeticion, campo) => {
    const res = await POST(peticion(cuerpoPeticion, sesion()));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(campo);
  });

  it('un cursor válido pasa y continúa la lista', async () => {
    const primera = await (await POST(peticion({}, sesion()))).json();
    expect(primera.siguiente).toBeNull();
    const res = await POST(peticion({ despues: { at: '2099-01-01T00:00:00+00:00', id: uuid(5) } }, sesion()));
    expect(res.status).toBe(200);
  });
});
