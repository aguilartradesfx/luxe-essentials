// tests/campanas-api-crear.test.ts
//
// POST /api/campanas/crear. La prueba que más importa de este archivo es
// la de "selección" -- que 'pagina' y 'zona' arman listas de destinatarios
// DISTINTAS, y que 'zona' NUNCA se reduce a lo que traiga `contactIds`. Es
// la ruta que decide a cuántos les llega la campaña, así que es donde un
// mutante que confundiera las dos ramas de la selección haría más daño.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type FilaUsuario = { id: string; rol: 'vendedor' | 'superadmin'; activo: boolean };
let usuarios: FilaUsuario[];
type FilaBaja = { correo: string };
let bajas: FilaBaja[];
type FilaEnvioInsertada = { campana_id: string; correo: string; contacto_id: string; nombre_crm: string };
let campanasCreadas: { id: string; zona: string; plantilla: string; asunto: string; html: string; creado_por: string }[];
let enviosInsertados: FilaEnvioInsertada[];
let siguienteId = 0;

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

function nodoBajas(): any {
  return {
    select: async () => ({ data: bajas, error: null }),
  };
}

function nodoCampanas(): any {
  return {
    insert: (cambios: any) => ({
      select: () => ({
        single: async () => {
          siguienteId++;
          const id = `camp-${siguienteId}`;
          campanasCreadas.push({ id, ...cambios });
          return { data: { id }, error: null };
        },
      }),
    }),
  };
}

function nodoCampanasEnvios(): any {
  return {
    upsert: (filas: FilaEnvioInsertada[], _opciones: any) => ({
      select: async () => {
        enviosInsertados.push(...filas);
        return { data: filas.map((_, i) => ({ id: `env-${i}` })), error: null };
      },
    }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      if (tabla === 'usuarios_panel') return nodoUsuarios();
      if (tabla === 'bajas_correo') return nodoBajas();
      if (tabla === 'campanas') return nodoCampanas();
      if (tabla === 'campanas_envios') return nodoCampanasEnvios();
      throw new Error(`tabla no mockeada: ${tabla}`);
    },
  }),
}));

const { POST: postCrear } = await import('@/app/api/campanas/crear/route');
const { POST: postPrevisualizar } = await import('@/app/api/campanas/previsualizar/route');
const { emitirSesion } = await import('@/lib/sesion');

const ID_SUPERADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_VENDEDOR = 'aaaaaaaa-0000-4000-8000-000000000002';

function sesionSuperadmin() {
  const { cookie, csrf } = emitirSesion('Ana Solano', 'superadmin', ID_SUPERADMIN);
  return { cookie: cookie.split(';')[0], csrf };
}

function peticion(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return new Request('https://luxeessentialscr.com/api/campanas/crear', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabeceras },
    body: JSON.stringify(cuerpo),
  });
}

// 5 contactos con correo en la zona (más uno sin correo, que nunca debería
// contarse ni en 'pagina' ni en 'zona').
const CONTACTOS_ZONA = [
  { id: 'c-1', firstName: 'Hotel Uno', email: 'uno@hotel.cr' },
  { id: 'c-2', firstName: 'Hotel Dos', email: 'dos@hotel.cr' },
  { id: 'c-3', firstName: 'Hotel Tres', email: 'tres@hotel.cr' },
  { id: 'c-4', firstName: 'Hotel Cuatro', email: 'cuatro@hotel.cr' },
  { id: 'c-5', firstName: 'Hotel Cinco', email: 'cinco@hotel.cr' },
  { id: 'c-6', firstName: 'Hotel Sin Correo' },
];

function mockGhl() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ contacts: CONTACTOS_ZONA }),
  } as unknown as Response);
}

const PARRAFOS_INICIAL = ['Primero.', 'Segundo.', 'Tercero.'];

beforeEach(() => {
  process.env.LUXE_SESION_SECRETO = 'secreta';
  process.env.LUXE_GHL_API_KEY = 'llave-ghl';
  process.env.LUXE_GHL_LOCATION_ID = 'loc-1';
  process.env.LUXE_BAJA_SECRETO = 'secreta-baja';
  usuarios = [
    { id: ID_SUPERADMIN, rol: 'superadmin', activo: true },
    { id: ID_VENDEDOR, rol: 'vendedor', activo: true },
  ];
  bajas = [];
  campanasCreadas = [];
  enviosInsertados = [];
  siguienteId = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('autenticación y autorización', () => {
  it('rechaza sin sesión (401)', async () => {
    const res = await postCrear(peticion({}));
    expect(res.status).toBe(401);
  });

  it('rechaza (401) una sesión válida sin el token anti-CSRF -- ruta que escribe', async () => {
    const { cookie } = sesionSuperadmin();
    const res = await postCrear(
      peticion(
        { zona: 'GAM Oeste', seleccion: 'zona', plantilla: 'inicial', parrafos: PARRAFOS_INICIAL },
        { cookie },
      ),
    );
    expect(res.status).toBe(401);
  });

  it('rechaza (403) a un vendedor de verdad, aunque la cookie diga superadmin', async () => {
    const { cookie, csrf } = emitirSesion('Guillermo Rojas', 'superadmin', ID_VENDEDOR);
    mockGhl();
    const res = await postCrear(
      peticion(
        { zona: 'GAM Oeste', seleccion: 'zona', plantilla: 'inicial', parrafos: PARRAFOS_INICIAL },
        { cookie: cookie.split(';')[0], 'x-csrf-token': csrf },
      ),
    );
    expect(res.status).toBe(403);
    expect(campanasCreadas).toHaveLength(0);
  });
});

describe('validación de entrada', () => {
  it('400 con una zona inválida', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCrear(
      peticion(
        { zona: 'Marte', seleccion: 'zona', plantilla: 'inicial', parrafos: PARRAFOS_INICIAL },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    expect(res.status).toBe(400);
  });

  it('400 si seleccion es "pagina" sin contactIds', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCrear(
      peticion(
        { zona: 'GAM Oeste', seleccion: 'pagina', plantilla: 'inicial', parrafos: PARRAFOS_INICIAL },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    expect(res.status).toBe(400);
    expect(campanasCreadas).toHaveLength(0);
  });

  it('400 si la cantidad de párrafos no coincide con la plantilla elegida', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCrear(
      peticion(
        { zona: 'GAM Oeste', seleccion: 'zona', plantilla: 'inicial', parrafos: ['sólo uno'] },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe('selección: "pagina" vs "zona" -- el candado central de esta ruta', () => {
  it('"pagina" con 2 contactIds crea una campaña de exactamente 2 destinatarios', async () => {
    mockGhl();
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCrear(
      peticion(
        {
          zona: 'GAM Oeste',
          seleccion: 'pagina',
          contactIds: ['c-1', 'c-2'],
          plantilla: 'inicial',
          parrafos: PARRAFOS_INICIAL,
        },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.destinatarios).toBe(2);
    expect(enviosInsertados.map((e) => e.correo).sort()).toEqual(['dos@hotel.cr', 'uno@hotel.cr']);
  });

  it('"zona" crea una campaña con TODOS los contactos con correo de la zona (5, no 2)', async () => {
    mockGhl();
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCrear(
      peticion(
        { zona: 'GAM Oeste', seleccion: 'zona', plantilla: 'inicial', parrafos: PARRAFOS_INICIAL },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.destinatarios).toBe(5);
    expect(enviosInsertados).toHaveLength(5);
  });

  // El caso que el diseño pide que sea IMPOSIBLE de confundir: mandar
  // `seleccion: 'zona'` junto con un `contactIds` corto (como si alguien
  // hubiera copiado el cuerpo de una petición de 'pagina' y sólo hubiera
  // cambiado la palabra) NO debe reducir el envío a esos dos contactos --
  // 'zona' ignora `contactIds` por completo. Si un mutante alguna vez
  // hiciera que 'zona' mirara `contactIds` cuando viene, esta prueba lo
  // atrapa: seguiría dando 5, no 2.
  it('"zona" IGNORA contactIds si por error viajan igual -- sigue mandando a toda la zona', async () => {
    mockGhl();
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCrear(
      peticion(
        {
          zona: 'GAM Oeste',
          seleccion: 'zona',
          contactIds: ['c-1', 'c-2'],
          plantilla: 'inicial',
          parrafos: PARRAFOS_INICIAL,
        },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    const cuerpo = await res.json();
    expect(cuerpo.destinatarios).toBe(5);
  });

  it('un contactId que no está en la zona (o inventado) no cuela un destinatario que no es de esa zona', async () => {
    mockGhl();
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCrear(
      peticion(
        {
          zona: 'GAM Oeste',
          seleccion: 'pagina',
          contactIds: ['c-1', 'no-existe-en-la-zona'],
          plantilla: 'inicial',
          parrafos: PARRAFOS_INICIAL,
        },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    const cuerpo = await res.json();
    expect(cuerpo.destinatarios).toBe(1);
    expect(enviosInsertados.map((e) => e.correo)).toEqual(['uno@hotel.cr']);
  });

  it('nunca confía en un correo que el cuerpo de la petición pudiera traer -- lo arma del lado del servidor, contra GHL', async () => {
    mockGhl();
    const { cookie, csrf } = sesionSuperadmin();
    await postCrear(
      peticion(
        {
          zona: 'GAM Oeste',
          seleccion: 'pagina',
          contactIds: ['c-1'],
          // Un campo que la ruta no espera y no valida -- no debe colar
          // nada.
          correoInventado: 'atacante@evil.example',
          plantilla: 'inicial',
          parrafos: PARRAFOS_INICIAL,
        },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    expect(enviosInsertados.map((e) => e.correo)).toEqual(['uno@hotel.cr']);
  });

  it('a quien no tiene correo en el CRM nunca le llega, ni en "zona" ni en "pagina" (aunque se pida su contactId)', async () => {
    mockGhl();
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCrear(
      peticion(
        {
          zona: 'GAM Oeste',
          seleccion: 'pagina',
          contactIds: ['c-6'],
          plantilla: 'inicial',
          parrafos: PARRAFOS_INICIAL,
        },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    expect(res.status).toBe(400);
    expect(campanasCreadas).toHaveLength(0);
  });
});

describe('exclusión de bajas', () => {
  it('descarta de la campaña a quien ya está dado de baja, y lo informa en excluidosPorBaja', async () => {
    mockGhl();
    bajas = [{ correo: 'dos@hotel.cr' }];
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCrear(
      peticion(
        { zona: 'GAM Oeste', seleccion: 'zona', plantilla: 'inicial', parrafos: PARRAFOS_INICIAL },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    const cuerpo = await res.json();
    expect(cuerpo.destinatarios).toBe(4);
    expect(cuerpo.excluidosPorBaja).toBe(1);
    expect(enviosInsertados.map((e) => e.correo)).not.toContain('dos@hotel.cr');
  });
});

// Punto 3 del encargo ("plantilla personalizada"): HTML pegado a mano en
// vez de una de las cuatro fijas. La firma de "ya se previsualizó" es real
// -- se consigue pasando por POST /api/campanas/previsualizar de verdad, no
// calculándola a mano en la prueba, para que estas pruebas ejerciten
// EXACTAMENTE el mismo camino que recorre quien usa la pantalla.
async function previsualizarYFirmar(asunto: string, html: string): Promise<string> {
  const { cookie, csrf } = sesionSuperadmin();
  const res = await postPrevisualizar(
    peticion(
      { plantilla: 'personalizada', asunto, html, destinatario: { nombreCrm: 'Ana Rodríguez', correo: 'ana@hotel.com' } },
      { cookie, 'x-csrf-token': csrf },
    ),
  );
  const cuerpo = await res.json();
  if (!cuerpo.ok) throw new Error(`previsualizar falló en la prueba de crear: ${cuerpo.error}`);
  return cuerpo.firmaPrevisualizacion as string;
}

const HTML_PERSONALIZADO_OK = '<p>Buenos días{{nombre}}: somos {{empresa}}.</p><a href="{{unsubscribe_url}}">Baja</a>';

describe('plantilla "personalizada"', () => {
  it('crea la campaña con el html YA saneado, con los marcadores sin resolver (igual que las cuatro fijas)', async () => {
    mockGhl();
    const firma = await previsualizarYFirmar('Asunto personalizado', HTML_PERSONALIZADO_OK);
    const { cookie, csrf } = sesionSuperadmin();

    const res = await postCrear(
      peticion(
        {
          zona: 'GAM Oeste',
          seleccion: 'zona',
          plantilla: 'personalizada',
          asunto: 'Asunto personalizado',
          html: HTML_PERSONALIZADO_OK,
          firmaPrevisualizacion: firma,
        },
        { cookie, 'x-csrf-token': csrf },
      ),
    );

    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.destinatarios).toBe(5);
    expect(campanasCreadas).toHaveLength(1);
    expect(campanasCreadas[0].plantilla).toBe('personalizada');
    expect(campanasCreadas[0].asunto).toBe('Asunto personalizado');
    expect(campanasCreadas[0].html).toContain('{{nombre}}');
    expect(campanasCreadas[0].html).toContain('{{unsubscribe_url}}');
  });

  it('400 sin firmaPrevisualizacion -- nunca se puede crear sin haber previsualizado', async () => {
    mockGhl();
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCrear(
      peticion(
        {
          zona: 'GAM Oeste',
          seleccion: 'zona',
          plantilla: 'personalizada',
          asunto: 'Asunto personalizado',
          html: HTML_PERSONALIZADO_OK,
        },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    expect(res.status).toBe(400);
    expect(campanasCreadas).toHaveLength(0);
  });

  // Mata al mutante que comparara la firma sólo contra el asunto, o sólo
  // contra el html: editar el html DESPUÉS de previsualizar (con la firma
  // vieja) tiene que seguir rechazándose.
  it('400 si el html se editó después de previsualizar (la firma queda vieja)', async () => {
    mockGhl();
    const firma = await previsualizarYFirmar('Asunto personalizado', HTML_PERSONALIZADO_OK);
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCrear(
      peticion(
        {
          zona: 'GAM Oeste',
          seleccion: 'zona',
          plantilla: 'personalizada',
          asunto: 'Asunto personalizado',
          html: HTML_PERSONALIZADO_OK + '<p>Un párrafo agregado después de previsualizar.</p>',
          firmaPrevisualizacion: firma,
        },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    expect(res.status).toBe(400);
    expect(campanasCreadas).toHaveLength(0);
  });

  it('400 si falta el marcador de baja, aunque venga con una firma (que de todas formas no podría ser válida)', async () => {
    mockGhl();
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCrear(
      peticion(
        {
          zona: 'GAM Oeste',
          seleccion: 'zona',
          plantilla: 'personalizada',
          asunto: 'Asunto personalizado',
          html: '<p>Sin enlace de baja.</p>',
          firmaPrevisualizacion: 'lo-que-sea',
        },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    expect(res.status).toBe(400);
    const cuerpo = await res.json();
    expect(cuerpo.error).toContain('{{unsubscribe_url}}');
    expect(campanasCreadas).toHaveLength(0);
  });

  it('sanea de nuevo del lado del servidor -- un <script> colado en el html crudo nunca llega a guardarse', async () => {
    mockGhl();
    const htmlConScript = HTML_PERSONALIZADO_OK + '<script>alert(1)</script>';
    const firma = await previsualizarYFirmar('Asunto personalizado', htmlConScript);
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postCrear(
      peticion(
        {
          zona: 'GAM Oeste',
          seleccion: 'zona',
          plantilla: 'personalizada',
          asunto: 'Asunto personalizado',
          html: htmlConScript,
          firmaPrevisualizacion: firma,
        },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.advertenciasHtml.some((a: string) => a.includes('<script>'))).toBe(true);
    expect(campanasCreadas[0].html).not.toContain('<script');
  });
});

describe('el html guardado', () => {
  it('lleva los párrafos editados y el asunto/preview de la plantilla, no editables', async () => {
    mockGhl();
    const { cookie, csrf } = sesionSuperadmin();
    await postCrear(
      peticion(
        { zona: 'GAM Oeste', seleccion: 'zona', plantilla: 'inicial', parrafos: ['Uno especial.', 'Dos.', 'Tres.'] },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    expect(campanasCreadas).toHaveLength(1);
    expect(campanasCreadas[0].html).toContain('Uno especial.');
    expect(campanasCreadas[0].asunto).toBe('Uniformes y textiles en 30-35 dias | Luxe Essentials');
    expect(campanasCreadas[0].creado_por).toBe('Ana Solano');
    // Punto 2 del encargo (hallazgo importante, revisión final): sin esto
    // no había forma de saber, mirando el historial, a qué zona se le
    // escribió. Mata al mutante que dejara de pasar `zona` a `crearCampana`.
    expect(campanasCreadas[0].zona).toBe('GAM Oeste');
  });
});
