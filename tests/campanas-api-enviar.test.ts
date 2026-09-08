// tests/campanas-api-enviar.test.ts
//
// POST /api/campanas/enviar. La lógica de tanda/retomable ya está probada
// a fondo en tests/campanas-envio.test.ts (`enviarTanda`) -- acá sólo
// importa la CÁSCARA: autenticación, csrf, autorización, validación, y que
// la ruta le pase a `enviarTanda` el `campanaId` correcto y traduzca su
// resultado sin inventar nada. NUNCA se llama a Resend de verdad: el
// `fetch` global se mockea siempre.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type FilaUsuario = { id: string; rol: 'vendedor' | 'superadmin'; activo: boolean };
let usuarios: FilaUsuario[];

type FilaEnvio = {
  id: string;
  campana_id: string;
  correo: string;
  nombre_crm: string;
  estado: 'pendiente' | 'enviado' | 'error';
  actualizado_at: string | null;
};
let envios: FilaEnvio[];
let campana: { id: string; asunto: string; html: string } | null;

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
      if (!campana) return { data: null, error: null };
      const idPedido = filtros.find(([c]) => c === 'id')?.[1];
      if (idPedido !== campana.id) return { data: null, error: null };
      return { data: { asunto: campana.asunto, html: campana.html }, error: null };
    },
  };
  return nodo;
}

function nodoCampanasEnvios(): any {
  return {
    update: (cambios: Partial<FilaEnvio>) => ({
      eq: async (_c: string, id: string) => {
        const fila = envios.find((e) => e.id === id);
        if (fila) Object.assign(fila, cambios);
        return { error: null };
      },
    }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      if (tabla === 'usuarios_panel') return nodoUsuarios();
      if (tabla === 'campanas') return nodoCampanas();
      if (tabla === 'campanas_envios') return nodoCampanasEnvios();
      throw new Error(`tabla no mockeada: ${tabla}`);
    },
    // `campanas_reclamar_pendientes`: mismo criterio simplificado que
    // documenta tests/equipo-api.test.ts para la rpc de cambiar estado --
    // reimplementación en JS de "tomar hasta `p_limite` pendientes", sin
    // pretender demostrar el `for update skip locked` de Postgres (eso es
    // un paso manual documentado aparte, igual que las otras rpc de este
    // repositorio).
    rpc: async (nombre: string, args: Record<string, unknown>) => {
      if (nombre !== 'campanas_reclamar_pendientes') throw new Error(`rpc no soportada: ${nombre}`);
      const limite = args.p_limite as number;
      const pendientes = envios.filter((e) => e.campana_id === args.p_campana_id && e.estado === 'pendiente');
      const reclamadas = pendientes.slice(0, limite);
      for (const f of reclamadas) f.actualizado_at = new Date().toISOString();
      return { data: reclamadas, error: null };
    },
  }),
}));

const { POST: postEnviar } = await import('@/app/api/campanas/enviar/route');
const { emitirSesion } = await import('@/lib/sesion');

const ID_SUPERADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_VENDEDOR = 'aaaaaaaa-0000-4000-8000-000000000002';

function sesionSuperadmin() {
  const { cookie, csrf } = emitirSesion('Ana Solano', 'superadmin', ID_SUPERADMIN);
  return { cookie: cookie.split(';')[0], csrf };
}

function peticion(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return new Request('https://luxeessentialscr.com/api/campanas/enviar', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabeceras },
    body: JSON.stringify(cuerpo),
  });
}

function respuestaResend(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

beforeEach(() => {
  process.env.LUXE_SESION_SECRETO = 'secreta';
  process.env.RESEND_API_KEY = 'llave-resend';
  process.env.LUXE_CORREO_REMITENTE = 'Luxe Essentials <campanas@send.luxeessentialscr.com>';
  process.env.LUXE_BAJA_SECRETO = 'secreta-baja';
  usuarios = [
    { id: ID_SUPERADMIN, rol: 'superadmin', activo: true },
    { id: ID_VENDEDOR, rol: 'vendedor', activo: true },
  ];
  campana = {
    id: 'camp-1',
    asunto: 'Asunto de prueba',
    html: 'Hola{{nombre}}, de {{empresa}}: {{unsubscribe_url}}',
  };
  envios = [
    { id: 'e-1', campana_id: 'camp-1', correo: 'uno@hotel.cr', nombre_crm: 'Hotel Uno', estado: 'pendiente', actualizado_at: null },
    { id: 'e-2', campana_id: 'camp-1', correo: 'dos@hotel.cr', nombre_crm: 'Hotel Dos', estado: 'pendiente', actualizado_at: null },
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('autenticación y autorización', () => {
  it('rechaza sin sesión (401)', async () => {
    const res = await postEnviar(peticion({ campanaId: 'camp-1' }));
    expect(res.status).toBe(401);
  });

  it('rechaza (401) una sesión válida sin el token anti-CSRF -- manda correo real', async () => {
    const { cookie } = sesionSuperadmin();
    const res = await postEnviar(peticion({ campanaId: 'camp-1' }, { cookie }));
    expect(res.status).toBe(401);
  });

  it('rechaza (403) a un vendedor de verdad, aunque la cookie diga superadmin -- y no manda nada a Resend', async () => {
    const fetchImpl = vi.spyOn(globalThis, 'fetch');
    const { cookie, csrf } = emitirSesion('Guillermo Rojas', 'superadmin', ID_VENDEDOR);
    const res = await postEnviar(
      peticion({ campanaId: 'camp-1' }, { cookie: cookie.split(';')[0], 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('validación', () => {
  it('400 sin campanaId', async () => {
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postEnviar(peticion({}, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(400);
  });
});

describe('camino feliz', () => {
  it('manda la tanda a Resend y cierra las filas como enviado', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respuestaResend({ data: [{ id: 'r-1' }, { id: 'r-2' }] }),
    );
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postEnviar(peticion({ campanaId: 'camp-1' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo).toEqual({ ok: true, procesados: 2, enviados: 2, fallidos: 0, terminada: true });
    expect(envios.every((e) => e.estado === 'enviado')).toBe(true);
  });

  it('una campaña ya toda enviada vuelve terminada:true sin llamar a Resend de nuevo', async () => {
    envios = envios.map((e) => ({ ...e, estado: 'enviado' as const }));
    const fetchImpl = vi.spyOn(globalThis, 'fetch');
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postEnviar(peticion({ campanaId: 'camp-1' }, { cookie, 'x-csrf-token': csrf }));
    const cuerpo = await res.json();
    expect(cuerpo).toEqual({ ok: true, procesados: 0, enviados: 0, fallidos: 0, terminada: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('502 si Resend falla entero -- y la fila queda retomable (sigue pendiente)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' } as unknown as Response);
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postEnviar(peticion({ campanaId: 'camp-1' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(502);
    expect(envios.every((e) => e.estado === 'pendiente')).toBe(true);
  });
});
