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
let columnasPedidas: string[];

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
        const nodo = envios.from(tabla);
        const seleccionar = nodo.select;
        nodo.select = (cols: string, opc?: any) => (columnasPedidas.push(`${tabla}:${cols}`), seleccionar(cols, opc));
        return nodo;
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
  columnasPedidas = [];
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

describe('POST /api/campanas/envios -- filas por página', () => {
  const sesion = () => cookieDe('Ana', 'superadmin', ID_SUPER);
  function conMuchos(n: number) {
    datos.envios = Array.from({ length: n }, () => envio({ campana_id: C1 }));
  }

  it('la lista permitida es exactamente 10, 20, 50 y 100, y por omisión son 10', async () => {
    const { TAMANOS_PAGINA, TAMANO_PAGINA } = await import('@/lib/campanas/tamanos-pagina');
    expect([...TAMANOS_PAGINA]).toEqual([10, 20, 50, 100]);
    expect(TAMANO_PAGINA).toBe(10);
  });

  it('sin pedir tamaño: 10 filas (no 50), y la respuesta dice que son 10', async () => {
    conMuchos(120);
    const cuerpo = await (await POST(peticion({}, sesion()))).json();
    expect(cuerpo.tamano).toBe(10);
    expect(cuerpo.envios).toHaveLength(10);
    expect(cuerpo.siguiente).not.toBeNull();
    expect(cuerpo.total).toBe(120);
  });

  it.each([10, 20, 50, 100])('el tamaño %i se respeta: trae justo esa cantidad', async (n) => {
    conMuchos(120);
    const cuerpo = await (await POST(peticion({ tamano: n }, sesion()))).json();
    expect(cuerpo.tamano).toBe(n);
    expect(cuerpo.envios).toHaveLength(n);
  });

  it.each([[0], [1], [7], [15], [101], [1000000000], [-10], [10.5], ['10'], ['100'], [true], [[10]], [{}], [Number.MAX_SAFE_INTEGER]])(
    'un tamaño inventado desde el navegador (%j) se rechaza con 400 y no consulta la lista',
    async (tamano) => {
      conMuchos(120);
      tablasLeidas = [];
      const res = await POST(peticion({ tamano }, sesion()));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('filas por página');
      expect(tablasLeidas).not.toContain('campanas_envios');
    },
  );

  it('con el tamaño elegido, página tras página, ninguna fila se repite ni se pierde', async () => {
    conMuchos(45);
    const vistos: string[] = [];
    let despues: unknown = undefined;
    for (let i = 0; i < 10; i++) {
      const c = await (await POST(peticion({ tamano: 20, despues }, sesion()))).json();
      vistos.push(...c.envios.map((e: any) => e.id));
      if (!c.siguiente) break;
      despues = c.siguiente;
    }
    expect(vistos).toHaveLength(45);
    expect(new Set(vistos).size).toBe(45);
  });
});

// Los ~10 KB del cuerpo de cada correo no viajan en el listado: con 100 filas
// serian 1 MB por pagina para algo que casi nunca se abre. El cuerpo se pide
// aparte, al abrir la ventana (POST /api/campanas/envios/correo).
describe('POST /api/campanas/envios -- el cuerpo del correo NO viaja', () => {
  const sesion = () => cookieDe('Ana', 'superadmin', ID_SUPER);
  const SENTINELA = 'CUERPO-DEL-CORREO-SENTINELA';

  beforeEach(() => {
    (datos.campanas[0] as any).html = `<p>${SENTINELA} {{empresa}} {{unsubscribe_url}}</p>`;
    (datos.campanas[0] as any).asunto = 'ASUNTO-SENTINELA';
    (datos.campanas[0] as any).preview_text = 'PREVIEW-SENTINELA';
  });

  it('la respuesta no trae el html, el asunto ni nada del cuerpo ni un enlace de baja', async () => {
    const texto = await (await POST(peticion({}, sesion()))).text();
    expect(texto).toContain('cliente@empresa.cr');
    expect(texto).not.toContain(SENTINELA);
    expect(texto).not.toContain('ASUNTO-SENTINELA');
    expect(texto).not.toContain('PREVIEW-SENTINELA');
    expect(texto).not.toContain('/baja?t=');
    expect(texto).not.toMatch(/"html"/);
  });

  it('ni siquiera se le pide a la base: ninguna consulta del listado nombra el html', async () => {
    await POST(peticion({}, sesion()));
    const pedidas = columnasPedidas.join(' | ');
    expect(pedidas).toContain('campanas_envios:');
    expect(pedidas).not.toMatch(/\bhtml\b/);
    expect(pedidas).not.toMatch(/\basunto\b/);
    expect(pedidas).not.toMatch(/preview_text/);
  });
});
