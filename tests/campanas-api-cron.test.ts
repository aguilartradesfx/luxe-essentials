// tests/campanas-api-cron.test.ts
//
// GET /api/campanas/cron -- el disparo diario del envío programado (encargo,
// punto 1). A diferencia de TODA otra ruta de app/api/campanas/*, ésta no
// pasa por `autenticarPeticion` (no hay sesión de panel ni CSRF: la llama
// Vercel Cron, un servidor, no un navegador) -- la única puerta es el
// secreto compartido `CRON_SECRET`.
//
// Mismo criterio de dos niveles que el resto de tests/campanas-api-*.test.ts:
// la lógica de fondo (rampa, cupo, no repetir, el interruptor) ya está
// probada a fondo en tests/campanas-programado.test.ts
// (`ejecutarEnvioProgramado`) -- se MOCKEA acá a propósito, para que esta
// prueba sea sólo la CÁSCARA: el secreto, y que la ruta traduzca el
// resultado sin inventar nada. NUNCA se llama a Resend ni a GoHighLevel de
// verdad -- ni siquiera hay un `fetch` real en juego en este archivo.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({ supabaseAdmin: () => ({ marca: 'db-fake' }) }));

const ejecutarEnvioProgramadoMock = vi.fn();
vi.mock('@/lib/campanas/programado', () => ({
  ejecutarEnvioProgramado: (...args: unknown[]) => ejecutarEnvioProgramadoMock(...args),
}));

const { GET: getCron } = await import('@/app/api/campanas/cron/route');

function peticion(cabeceras: Record<string, string> = {}) {
  return new Request('https://luxeessentialscr.com/api/campanas/cron', {
    method: 'GET',
    headers: cabeceras,
  });
}

const SECRETO = 'el-secreto-de-verdad';

beforeEach(() => {
  ejecutarEnvioProgramadoMock.mockReset();
  ejecutarEnvioProgramadoMock.mockResolvedValue({ ok: true, accion: 'sin_pendientes' });
  process.env.RESEND_API_KEY = 'llave-resend';
  process.env.LUXE_CORREO_REMITENTE = 'Luxe <campanas@send.luxeessentialscr.com>';
  process.env.LUXE_GHL_API_KEY = 'llave-ghl';
  process.env.LUXE_GHL_LOCATION_ID = 'loc-1';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CRON_SECRET;
});

describe('declara maxDuration', () => {
  it('declara maxDuration >= 30', async () => {
    const modulo = await import('@/app/api/campanas/cron/route');
    expect(typeof modulo.maxDuration).toBe('number');
    expect(modulo.maxDuration).toBeGreaterThanOrEqual(30);
  });
});

describe('falla cerrado sin CRON_SECRET configurado', () => {
  // El punto explícito del encargo: "que la ruta falle cerrada y ruidosa
  // si la variable no está -- nunca que mande sin comprobar". Mata al
  // mutante que borrara este chequeo entero: sin él, un `Authorization`
  // vacío pasaría la comparación `undefined === undefined`-like contra un
  // `CRON_SECRET` también vacío/ausente.
  it('500, y ni siquiera llama a ejecutarEnvioProgramado, aunque la cabecera traiga algo', async () => {
    delete process.env.CRON_SECRET;
    const res = await getCron(peticion({ authorization: 'Bearer lo-que-sea' }));
    expect(res.status).toBe(500);
    expect(ejecutarEnvioProgramadoMock).not.toHaveBeenCalled();
  });

  it('500 también sin ninguna cabecera Authorization', async () => {
    delete process.env.CRON_SECRET;
    const res = await getCron(peticion());
    expect(res.status).toBe(500);
    expect(ejecutarEnvioProgramadoMock).not.toHaveBeenCalled();
  });

  it('un CRON_SECRET vacío ("") cuenta como "no configurado" -- falla cerrado igual', async () => {
    process.env.CRON_SECRET = '';
    const res = await getCron(peticion({ authorization: 'Bearer ' }));
    expect(res.status).toBe(500);
    expect(ejecutarEnvioProgramadoMock).not.toHaveBeenCalled();
  });
});

describe('autorización con CRON_SECRET configurado', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRETO;
  });

  it('401 sin cabecera Authorization', async () => {
    const res = await getCron(peticion());
    expect(res.status).toBe(401);
    expect(ejecutarEnvioProgramadoMock).not.toHaveBeenCalled();
  });

  it('401 con el secreto incorrecto', async () => {
    const res = await getCron(peticion({ authorization: `Bearer ${SECRETO}-no` }));
    expect(res.status).toBe(401);
    expect(ejecutarEnvioProgramadoMock).not.toHaveBeenCalled();
  });

  // Mata al mutante que comparara con `.includes()`/`.startsWith()` en vez
  // de una igualdad exacta: un secreto que EMPIEZA como el correcto pero
  // sigue con más caracteres no puede colarse.
  it('401 con un secreto que arranca igual al correcto pero sigue con más caracteres', async () => {
    const res = await getCron(peticion({ authorization: `Bearer ${SECRETO}xxxxxxxx` }));
    expect(res.status).toBe(401);
    expect(ejecutarEnvioProgramadoMock).not.toHaveBeenCalled();
  });

  // Mata al mutante que comparara sólo un PREFIJO del secreto correcto.
  it('401 con sólo una parte del secreto correcto', async () => {
    const res = await getCron(peticion({ authorization: `Bearer ${SECRETO.slice(0, 5)}` }));
    expect(res.status).toBe(401);
  });

  it('200 con el secreto correcto -- llama a ejecutarEnvioProgramado con las credenciales del entorno', async () => {
    const res = await getCron(peticion({ authorization: `Bearer ${SECRETO}` }));
    expect(res.status).toBe(200);
    expect(ejecutarEnvioProgramadoMock).toHaveBeenCalledTimes(1);
    const [db, deps] = ejecutarEnvioProgramadoMock.mock.calls[0];
    expect(db).toEqual({ marca: 'db-fake' });
    expect(deps).toEqual({
      resendApiKey: 'llave-resend',
      remitente: 'Luxe <campanas@send.luxeessentialscr.com>',
      apiKey: 'llave-ghl',
      locationId: 'loc-1',
    });
  });
});

describe('traduce el resultado de ejecutarEnvioProgramado', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRETO;
  });

  it('200 y el cuerpo tal cual cuando pausado', async () => {
    ejecutarEnvioProgramadoMock.mockResolvedValue({ ok: true, accion: 'pausado' });
    const res = await getCron(peticion({ authorization: `Bearer ${SECRETO}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accion: 'pausado' });
  });

  it('200 y el cuerpo tal cual cuando manda una tanda', async () => {
    ejecutarEnvioProgramadoMock.mockResolvedValue({
      ok: true,
      accion: 'enviado',
      zona: 'Guanacaste Interior',
      campanaId: 'camp-1',
      campanaNueva: true,
      cupoReservado: 22,
      procesados: 22,
      enviados: 22,
      fallidos: 0,
    });
    const res = await getCron(peticion({ authorization: `Bearer ${SECRETO}` }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.accion).toBe('enviado');
    expect(cuerpo.zona).toBe('Guanacaste Interior');
    expect(cuerpo.cupoReservado).toBe(22);
  });

  it('502 cuando ejecutarEnvioProgramado falla', async () => {
    ejecutarEnvioProgramadoMock.mockResolvedValue({ ok: false, error: 'no se pudo consultar el CRM' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await getCron(peticion({ authorization: `Bearer ${SECRETO}` }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: 'no se pudo consultar el CRM' });
    spy.mockRestore();
  });
});
