// POST /api/campanas/envios/correo: el correo de UNA persona, con su enlace
// de baja real adentro. Mismo criterio que campanas-api-envios.test.ts:
// cookie VALIDA de verdad, y sólo difiere la FILA de `usuarios_panel` -- la
// promesa central es que `autorizarSuperadmin` relee la base.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uuid } from './helpers/db-envios';

type FilaUsuario = { id: string; rol: 'vendedor' | 'superadmin'; activo: boolean };
let usuarios: FilaUsuario[];
let envios: any[];
let campanas: any[];
let tablasLeidas: string[];

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      tablasLeidas.push(tabla);
      const fuente = tabla === 'usuarios_panel' ? usuarios : tabla === 'campanas_envios' ? envios : campanas;
      const filtros: [string, unknown][] = [];
      let estados: unknown[] | null = null;
      const nodo: any = {
        select: () => nodo,
        eq: (c: string, v: unknown) => (filtros.push([c, v]), nodo),
        in: (_c: string, vs: unknown[]) => ((estados = vs), nodo),
        maybeSingle: async () => ({
          data:
            fuente.find((f: any) => filtros.every(([c, v]) => f[c] === v) && (!estados || estados.includes(f.estado))) ??
            null,
          error: null,
        }),
      };
      return nodo;
    },
  }),
}));

const { POST } = await import('@/app/api/campanas/envios/correo/route');
const { emitirSesion } = await import('@/lib/sesion');
const { _reiniciarCacheAutenticacion } = await import('@/lib/autenticacion-cotizador');

const ID_SUPER = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_VENDEDOR = 'aaaaaaaa-0000-4000-8000-000000000002';
const C1 = uuid(9001);
const E1 = uuid(1);

function peticion(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return new Request('https://luxeessentialscr.com/api/campanas/envios/correo', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabeceras },
    body: JSON.stringify(cuerpo),
  });
}
function cookieDe(nombre: string, rol: 'vendedor' | 'superadmin', id: string) {
  return { cookie: emitirSesion(nombre, rol, id).cookie.split(';')[0] };
}
const sesion = () => cookieDe('Ana', 'superadmin', ID_SUPER);

beforeEach(() => {
  _reiniciarCacheAutenticacion();
  process.env.LUXE_SESION_SECRETO = 'secreta';
  process.env.LUXE_BAJA_SECRETO = 'secreta-de-baja';
  usuarios = [
    { id: ID_SUPER, rol: 'superadmin', activo: true },
    { id: ID_VENDEDOR, rol: 'vendedor', activo: true },
  ];
  campanas = [
    {
      id: C1,
      asunto: 'Asunto de prueba',
      html: '<body><p>Hola de {{empresa}}</p><a href="{{unsubscribe_url}}">baja</a></body>',
      preview_text: null,
      zona: 'Zona Norte',
      plantilla: 'inicial',
    },
  ];
  envios = [
    {
      id: E1,
      campana_id: C1,
      correo: 'cliente@empresa.cr',
      nombre_crm: 'Hotel Arenal',
      estado: 'enviado',
      actualizado_at: '2026-09-20T15:00:00+00:00',
    },
  ];
  tablasLeidas = [];
});

describe('POST /api/campanas/envios/correo -- autorización', () => {
  it('sin sesión: 401, y no toca ni envíos ni campañas', async () => {
    const res = await POST(peticion({ id: E1 }));
    expect(res.status).toBe(401);
    expect(tablasLeidas).not.toContain('campanas_envios');
    expect(tablasLeidas).not.toContain('campanas');
  });

  it('un vendedor de verdad: 403, sin una palabra del correo en la respuesta', async () => {
    const res = await POST(peticion({ id: E1 }, cookieDe('Guillermo', 'vendedor', ID_VENDEDOR)));
    expect(res.status).toBe(403);
    const texto = await res.text();
    expect(texto).not.toContain('cliente@empresa.cr');
    expect(texto).not.toContain('Hotel Arenal');
    expect(texto).not.toContain('/baja?t=');
    expect(tablasLeidas).not.toContain('campanas_envios');
    expect(tablasLeidas).not.toContain('campanas');
  });

  it('cookie que dice superadmin pero la fila real es vendedor: 403 (se relee la base)', async () => {
    const res = await POST(peticion({ id: E1 }, cookieDe('Guillermo', 'superadmin', ID_VENDEDOR)));
    expect(res.status).toBe(403);
    expect(tablasLeidas).not.toContain('campanas_envios');
  });

  it('un superadmin desactivado después de iniciar sesión: no ve nada', async () => {
    usuarios[0].activo = false;
    const res = await POST(peticion({ id: E1 }, sesion()));
    expect([401, 403]).toContain(res.status);
    expect(await res.text()).not.toContain('cliente@empresa.cr');
  });
});

describe('POST /api/campanas/envios/correo -- el correo', () => {
  it('un superadmin: 200 con el asunto, el cuerpo resuelto y los datos de la persona; sin csrf', async () => {
    const res = await POST(peticion({ id: E1 }, sesion()));
    expect(res.status).toBe(200);
    const { ok, correo } = await res.json();
    expect(ok).toBe(true);
    expect(correo.asunto).toBe('Asunto de prueba');
    expect(correo.html).toContain('Hola de Hotel Arenal');
    expect(correo.html).toContain('/baja?t=');
    expect(correo).toMatchObject({
      destinatario: 'cliente@empresa.cr',
      empresa: 'Hotel Arenal',
      zona: 'Zona Norte',
      campanaId: C1,
      salio: true,
    });
  });

  it.each([[undefined], [null], [''], ['no-es-uuid'], [5], [{}], [[E1]]])('un id inválido (%j): 400', async (id) => {
    const res = await POST(peticion({ id }, sesion()));
    expect(res.status).toBe(400);
    expect(tablasLeidas).not.toContain('campanas_envios');
  });

  it('un id que no existe: 404', async () => {
    const res = await POST(peticion({ id: uuid(777) }, sesion()));
    expect(res.status).toBe(404);
  });

  it('un envío todavía pendiente (nunca se mandó): 404', async () => {
    envios[0].estado = 'pendiente';
    const res = await POST(peticion({ id: E1 }, sesion()));
    expect(res.status).toBe(404);
  });

  it('un cuerpo que no es JSON: 400', async () => {
    const res = await POST(
      new Request('https://luxeessentialscr.com/api/campanas/envios/correo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{no',
      }),
    );
    expect(res.status).toBe(400);
  });
});
