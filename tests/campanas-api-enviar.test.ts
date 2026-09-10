// tests/campanas-api-enviar.test.ts
//
// POST /api/campanas/enviar. La lógica de tanda/retomable ya está probada
// a fondo en tests/campanas-envio.test.ts (`enviarTanda`) -- acá importa la
// CÁSCARA: autenticación, csrf, autorización, validación, que la ruta le
// pase a `enviarTanda` el `campanaId` correcto y traduzca su resultado sin
// inventar nada -- Y, desde el hallazgo de producción del 2026-09-10, la
// guardia de cupo diario que esta ruta agrega ANTES de llamar a
// `enviarTanda` (ver el comentario grande de app/api/campanas/enviar/route.ts):
// ninguna campaña -- programada o armada a mano -- puede mandar más de lo
// que le queda al día, y el cupo lo comparte el mismo registro
// (`campanas_envio_diario`) que ya usa el cron del envío programado.
// NUNCA se llama a Resend de verdad: el `fetch` global se mockea siempre.
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
let campana: { id: string; asunto: string; html: string; cancelada_at: string | null } | null;

type FilaEnvioDiario = { fecha: string; tope: number; enviados: number };
let envioDiario: FilaEnvioDiario[];

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
      // Se devuelven las tres columnas siempre -- la ruta y `enviarTanda`
      // piden distintos subconjuntos (`cancelada_at` la ruta, para no
      // reservar cupo de una campaña ya cancelada; `asunto`/`html`/
      // `cancelada_at` `enviarTanda`) -- este doble no simula la proyección
      // de columnas de PostgREST, alcanza con traer siempre el objeto
      // entero.
      return { data: { asunto: campana.asunto, html: campana.html, cancelada_at: campana.cancelada_at }, error: null };
    },
  };
  return nodo;
}

// La guardia de cupo (`progresoCampana`, lib/campanas/progreso.ts) cuenta
// `campanas_envios` por `head:true` -- este nodo soporta ESE conteo
// (select con count/head + hasta dos `.eq()` encadenados), sobre el mismo
// arreglo `envios` que ya usan los rpc de reclamo/cierre más abajo. Nunca
// se pidió nada más que un conteo desde este módulo -- si algún día hiciera
// falta traer filas, este doble lo notaría al toque (revienta, no inventa
// un resultado).
function nodoEnviosConteo(): any {
  const filtros: [string, unknown][] = [];
  let conteoHead = false;
  const nodo: any = {
    select(_campos?: string, opciones?: { count?: string; head?: boolean }) {
      conteoHead = Boolean(opciones?.head);
      return nodo;
    },
    eq(c: string, v: unknown) {
      filtros.push([c, v]);
      return nodo;
    },
    then: (resolve: any, reject: any) => {
      const encontradas = envios.filter((e) => filtros.every(([c, v]) => (e as any)[c] === v));
      if (!conteoHead) return Promise.reject(new Error('El doble sólo soporta conteos (select con head:true).')).catch(reject);
      return Promise.resolve({ count: encontradas.length, data: null, error: null }).then(resolve, reject);
    },
  };
  return nodo;
}

// `diaDeRampa` (lib/campanas/programado.ts) cuenta filas de
// `campanas_envio_diario` con `fecha < hoy` -- lo único que este nodo
// necesita soportar del lado de lectura. La escritura de la reserva en sí
// vive ENTERA en el rpc (más abajo), igual que en producción.
function nodoEnvioDiario(): any {
  const filtros: Array<['lt', string, unknown]> = [];
  let conteoHead = false;
  const nodo: any = {
    select(_campos?: string, opciones?: { count?: string; head?: boolean }) {
      conteoHead = Boolean(opciones?.head);
      return nodo;
    },
    lt(c: string, v: unknown) {
      filtros.push(['lt', c, v]);
      return nodo;
    },
    then: (resolve: any, reject: any) => {
      const encontradas = envioDiario.filter((f) => filtros.every(([, c, v]) => (f as any)[c] < (v as any)));
      if (!conteoHead) return Promise.reject(new Error('El doble sólo soporta conteos (select con head:true).')).catch(reject);
      return Promise.resolve({ count: encontradas.length, data: null, error: null }).then(resolve, reject);
    },
  };
  return nodo;
}

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      if (tabla === 'usuarios_panel') return nodoUsuarios();
      if (tabla === 'campanas') return nodoCampanas();
      if (tabla === 'campanas_envios') return nodoEnviosConteo();
      if (tabla === 'campanas_envio_diario') return nodoEnvioDiario();
      throw new Error(`tabla no mockeada: ${tabla}`);
    },
    // `campanas_reclamar_pendientes`/`campanas_cerrar_tanda`: mismo criterio
    // simplificado que documenta tests/equipo-api.test.ts para la rpc de
    // cambiar estado -- reimplementación en JS de lo que hace cada
    // sentencia, sin pretender demostrar el `for update skip locked` ni el
    // `update ... from jsonb_to_recordset` de Postgres (eso es un paso
    // manual documentado aparte, igual que las otras rpc de este
    // repositorio). `campanas_reservar_cupo_diario`: misma reimplementación,
    // exacta, que ya usa tests/campanas-programado.test.ts para la MISMA
    // función de producción (migración 0027) -- el "primero en escribir
    // fija el tope del día" incluido.
    rpc: async (nombre: string, args: Record<string, unknown>) => {
      if (nombre === 'campanas_reservar_cupo_diario') {
        const p_fecha = args.p_fecha as string;
        const p_tope = args.p_tope as number;
        const p_solicitado = args.p_solicitado as number;
        if (p_solicitado <= 0) return { data: 0, error: null };
        let fila = envioDiario.find((f) => f.fecha === p_fecha);
        if (!fila) {
          fila = { fecha: p_fecha, tope: Math.max(0, p_tope), enviados: 0 };
          envioDiario.push(fila);
        }
        const reserva = Math.max(0, Math.min(p_solicitado, fila.tope - fila.enviados));
        fila.enviados += reserva;
        return { data: reserva, error: null };
      }
      if (nombre === 'campanas_reclamar_pendientes') {
        const limite = args.p_limite as number;
        const pendientes = envios.filter((e) => e.campana_id === args.p_campana_id && e.estado === 'pendiente');
        const reclamadas = pendientes.slice(0, limite);
        for (const f of reclamadas) f.actualizado_at = new Date().toISOString();
        return { data: reclamadas, error: null };
      }
      if (nombre === 'campanas_cerrar_tanda') {
        const resultados = args.p_resultados as Array<{ id: string; estado: string; resend_id: string | null; error: string | null; actualizado_at: string }>;
        for (const r of resultados) {
          const fila = envios.find((e) => e.id === r.id);
          if (fila) Object.assign(fila, { estado: r.estado, actualizado_at: r.actualizado_at });
        }
        return { data: resultados.length, error: null };
      }
      throw new Error(`rpc no soportada: ${nombre}`);
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

// La misma fecha ('YYYY-MM-DD') que calcula la ruta con `new Date()` --
// esta ruta no recibe un reloj inyectado (a diferencia de `enviarTanda`),
// así que las pruebas de cupo siembran `campanas_envio_diario` contra la
// fecha REAL de hoy, no una fija.
function hoyIso(): string {
  return new Date().toISOString().slice(0, 10);
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
    cancelada_at: null,
  };
  envios = [
    { id: 'e-1', campana_id: 'camp-1', correo: 'uno@hotel.cr', nombre_crm: 'Hotel Uno', estado: 'pendiente', actualizado_at: null },
    { id: 'e-2', campana_id: 'camp-1', correo: 'dos@hotel.cr', nombre_crm: 'Hotel Dos', estado: 'pendiente', actualizado_at: null },
  ];
  // Sin ninguna fila de hoy: `diaDeRampa` da día 1 (tope 25) -- de sobra
  // para las dos filas 'pendiente' de arriba, así que el camino feliz no
  // se topa con el cupo salvo que la prueba lo siembre a propósito.
  envioDiario = [];
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

// Hallazgo importante (revisión final, punto 1): era la única ruta pesada
// de app/api/campanas/* sin `maxDuration` -- mismo criterio que
// tests/api-cotizacion.test.ts para app/api/cotizacion/route.ts.
describe('app/api/campanas/enviar/route.ts declara un maxDuration', () => {
  it('declara maxDuration', async () => {
    const modulo = await import('@/app/api/campanas/enviar/route');
    expect(typeof modulo.maxDuration).toBe('number');
    expect(modulo.maxDuration).toBeGreaterThanOrEqual(30);
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
    // El cupo diario quedó reservado con lo que de verdad se mandó.
    expect(envioDiario).toEqual([{ fecha: hoyIso(), tope: 25, enviados: 2 }]);
  });

  it('una campaña ya toda enviada vuelve terminada:true sin llamar a Resend de nuevo, y sin tocar el cupo', async () => {
    envios = envios.map((e) => ({ ...e, estado: 'enviado' as const }));
    const fetchImpl = vi.spyOn(globalThis, 'fetch');
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postEnviar(peticion({ campanaId: 'camp-1' }, { cookie, 'x-csrf-token': csrf }));
    const cuerpo = await res.json();
    expect(cuerpo).toEqual({ ok: true, procesados: 0, enviados: 0, fallidos: 0, terminada: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    // Sin pendientes, la ruta nunca llega a reservar cupo -- nada que
    // gastar en una campaña que ya no tiene nada por mandar.
    expect(envioDiario).toEqual([]);
  });

  it('502 si Resend falla entero -- y la fila queda retomable (sigue pendiente)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' } as unknown as Response);
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postEnviar(peticion({ campanaId: 'camp-1' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(502);
    expect(envios.every((e) => e.estado === 'pendiente')).toBe(true);
  });
});

// =======================================================================
// El cupo diario -- hallazgo de producción (2026-09-10): "Retomar" sobre
// una campaña programada mandaba de un tirón lo que la rampa reparte en
// semanas, porque esta ruta no miraba el cupo para nada. Ahora reserva,
// ANTES de llamar a `enviarTanda`, con la MISMA función que usa el cron
// (`reservarCupoDiario`) -- corre para TODA campaña, programada o no.
describe('cupo diario', () => {
  it('sin cupo disponible hoy: 409, no manda nada a Resend, la campaña queda donde iba', async () => {
    // Tope de hoy ya agotado -- mismo escenario que documenta el encargo:
    // "cupo de hoy que ya está en 25 de 25".
    envioDiario = [{ fecha: hoyIso(), tope: 25, enviados: 25 }];
    const fetchImpl = vi.spyOn(globalThis, 'fetch');
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postEnviar(peticion({ campanaId: 'camp-1' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(409);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    // Ni una fila se tocó -- ni se reclamó, ni se marcó, nada.
    expect(envios.every((e) => e.estado === 'pendiente' && e.actualizado_at === null)).toBe(true);
    // El cupo tampoco se movió -- seguía en 25/25 antes y después.
    expect(envioDiario).toEqual([{ fecha: hoyIso(), tope: 25, enviados: 25 }]);
  });

  // Mata al mutante que cambia `cupo <= 0` por `cupo < 0` (dejaría pasar un
  // 0 exacto de cupo disponible) y al que invierte la condición entera.
  it('con cupo en EXACTAMENTE cero: también 409, nunca "algo alcanza"', async () => {
    envioDiario = [{ fecha: hoyIso(), tope: 2, enviados: 2 }];
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postEnviar(peticion({ campanaId: 'camp-1' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(409);
  });

  it('con cupo PARCIAL: manda sólo lo que alcanza, deja el resto pendiente, y reserva exactamente eso', async () => {
    // Sólo queda 1 de cupo hoy -- hay 2 pendientes.
    envioDiario = [{ fecha: hoyIso(), tope: 25, enviados: 24 }];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respuestaResend({ data: [{ id: 'r-1' }] }));
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postEnviar(peticion({ campanaId: 'camp-1' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo).toEqual({ ok: true, procesados: 1, enviados: 1, fallidos: 0, terminada: false });
    const enviadas = envios.filter((e) => e.estado === 'enviado');
    const pendientes = envios.filter((e) => e.estado === 'pendiente');
    expect(enviadas).toHaveLength(1);
    expect(pendientes).toHaveLength(1);
    expect(envioDiario).toEqual([{ fecha: hoyIso(), tope: 25, enviados: 25 }]);
  });

  it('nunca reserva ni manda más de lo pendiente, aunque el cupo disponible sea mayor', async () => {
    // Cupo de sobra (100), pero sólo hay 2 pendientes -- se reservan 2, no
    // 100. Mata al mutante que reserva `TAMANO_TANDA` a secas en vez de
    // `min(pendientes, TAMANO_TANDA)`.
    envioDiario = [{ fecha: hoyIso(), tope: 100, enviados: 0 }];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respuestaResend({ data: [{ id: 'r-1' }, { id: 'r-2' }] }));
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postEnviar(peticion({ campanaId: 'camp-1' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(200);
    expect(envioDiario).toEqual([{ fecha: hoyIso(), tope: 100, enviados: 2 }]);
  });

  it('una campaña YA cancelada, con pendientes, no reserva cupo -- no hay nada que mandar de todas formas', async () => {
    campana = { ...campana!, cancelada_at: '2026-09-09T12:00:00.000Z' };
    const fetchImpl = vi.spyOn(globalThis, 'fetch');
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postEnviar(peticion({ campanaId: 'camp-1' }, { cookie, 'x-csrf-token': csrf }));
    const cuerpo = await res.json();
    expect(res.status).toBe(200);
    expect(cuerpo).toEqual({ ok: true, procesados: 0, enviados: 0, fallidos: 0, terminada: true, cancelada: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    // El punto del caso: el cupo del día sigue intacto para otra campaña.
    expect(envioDiario).toEqual([]);
  });

  // El mismo registro diario, para CUALQUIER campaña que pase por esta
  // ruta -- el pedido explícito es "que las manuales también cuenten".
  // Esta campaña no tiene ninguna marca de "programada" en el doble (no
  // hace falta: la ruta no distingue -- ver el comentario grande de
  // route.ts) y de todas formas respeta el mismo tope.
  it('una campaña manual (sin ninguna marca de "programada") respeta el mismo cupo diario', async () => {
    envioDiario = [{ fecha: hoyIso(), tope: 25, enviados: 25 }];
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postEnviar(peticion({ campanaId: 'camp-1' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(409);
  });

  // El tope duro de 100: aunque la rampa ya esté en el día 6+ (tope 100),
  // reservar nunca puede dejar `enviados` por encima de 100 -- mata al
  // mutante que reemplaza el `min` del rpc por el número solicitado a
  // secas.
  it('el tope diario nunca se pasa de 100, ni con muchos pendientes y cupo de sobra', async () => {
    envios = Array.from({ length: 5 }, (_, i) => ({
      id: `e-${i}`,
      campana_id: 'camp-1',
      correo: `hotel${i}@correo.cr`,
      nombre_crm: `Hotel ${i}`,
      estado: 'pendiente' as const,
      actualizado_at: null,
    }));
    envioDiario = [{ fecha: hoyIso(), tope: 100, enviados: 97 }];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respuestaResend({ data: [{ id: 'r-1' }, { id: 'r-2' }, { id: 'r-3' }] }),
    );
    const { cookie, csrf } = sesionSuperadmin();
    const res = await postEnviar(peticion({ campanaId: 'camp-1' }, { cookie, 'x-csrf-token': csrf }));
    const cuerpo = await res.json();
    expect(cuerpo.enviados).toBe(3);
    expect(envioDiario[0].enviados).toBe(100);
    expect(envios.filter((e) => e.estado === 'enviado')).toHaveLength(3);
    expect(envios.filter((e) => e.estado === 'pendiente')).toHaveLength(2);
  });
});
