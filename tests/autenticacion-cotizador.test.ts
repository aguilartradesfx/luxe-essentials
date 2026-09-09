import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// I6 (revision-final-2.md): `autenticarPeticion` releía sólo la firma de la
// cookie y nunca tocaba `usuarios_panel` -- desactivar a alguien no le
// cortaba el paso hasta que su cookie de 30 días caducara sola. Este
// archivo prueba directamente la función (sin pasar por ninguna ruta) para
// poder controlar con precisión la caché y los fallos de lectura, algo que
// las pruebas de las rutas (tests/api-cotizacion-sesion.test.ts, etc.) no
// necesitan hacer con este nivel de detalle.

type FilaUsuario = { id: string; rol: 'vendedor' | 'superadmin'; activo: boolean };
let usuarios: FilaUsuario[];
let erroresLectura: { message: string } | null;
// Testigo directo de "se hizo una lectura de verdad contra la base" -- más
// simple y más fiel que contar accesos a algún método del arreglo: cuenta
// exactamente las veces que `maybeSingle` (el punto que de verdad golpea la
// base en el código real) corrió.
let lecturasBase = 0;

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
      lecturasBase++;
      if (erroresLectura) return { data: null, error: erroresLectura };
      const m = usuarios.filter((u) => filtros.every(([c, v]) => (u as Record<string, unknown>)[c] === v));
      return { data: m[0] ?? null, error: null };
    },
  };
  return nodo;
}

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      if (tabla === 'usuarios_panel') return nodoUsuarios();
      throw new Error(`tabla no mockeada en este doble: ${tabla}`);
    },
  }),
}));

const { autenticarPeticion, _reiniciarCacheAutenticacion } = await import('@/lib/autenticacion-cotizador');
const { emitirSesion } = await import('@/lib/sesion');

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function peticionCon(cookieCompleta: string, csrf?: string): Request {
  return new Request('https://luxeessentialscr.com/api/cotizacion/listado', {
    headers: { cookie: cookieCompleta, ...(csrf ? { 'x-csrf-token': csrf } : {}) },
  });
}

function cookieDe(rolFirmado: 'vendedor' | 'superadmin' = 'vendedor', id: string = ID) {
  const { cookie, csrf } = emitirSesion('Guillermo Rojas', rolFirmado, id);
  return { valor: cookie.split(';')[0], csrf };
}

beforeEach(() => {
  process.env.LUXE_SESION_SECRETO = 'secreta';
  usuarios = [{ id: ID, rol: 'vendedor', activo: true }];
  erroresLectura = null;
  lecturasBase = 0;
  // Sin esto, una prueba que desactiva a `ID` dejaría esa entrada en caché
  // para la siguiente prueba de este mismo archivo -- Vitest no reimporta
  // el módulo entre pruebas.
  _reiniciarCacheAutenticacion();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('autenticarPeticion — camino feliz (persona activa)', () => {
  it('deja pasar a una persona activa, con su nombre y su id', async () => {
    const { valor } = cookieDe();
    const r = await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });
    expect(r).toEqual({ ok: true, vendedor: 'Guillermo Rojas', rol: 'vendedor', id: ID });
  });

  it('usa el ROL FRESCO de la base, no el que quedó firmado en la cookie', async () => {
    // La cookie quedó firmada como "vendedor" -- un ascenso a superadmin
    // ocurrió después, sin que esta persona haya vuelto a entrar.
    usuarios[0].rol = 'superadmin';
    const { valor } = cookieDe('vendedor');
    const r = await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });
    expect(r).toMatchObject({ ok: true, rol: 'superadmin' });
  });

  it('sigue exigiendo el token anti-CSRF en las rutas que lo piden, antes de tocar la base', async () => {
    const { valor } = cookieDe();
    const r = await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: true });
    expect(r).toEqual({ ok: false, status: 401, error: 'Token anti-CSRF inválido.' });
  });

  it('con el token anti-CSRF correcto, pasa (200 lógico)', async () => {
    const { valor, csrf } = cookieDe();
    const r = await autenticarPeticion(peticionCon(valor, csrf), {}, { requiereCsrf: true });
    expect(r.ok).toBe(true);
  });
});

describe('autenticarPeticion — I6: a alguien desactivado se lo rechaza', () => {
  it('rechaza (401) a alguien desactivado en la base, aunque su cookie siga firmada y vigente', async () => {
    usuarios[0].activo = false;
    const { valor } = cookieDe();
    const r = await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      // Mismo mensaje genérico que una cookie vencida: no le confirma a
      // quien fue dado de baja que su cuenta existe y está desactivada
      // (mismo criterio, documentado en el archivo, que "nunca hubo
      // sesión" vs. "expiró").
      expect(r.error).toBe('Tu sesión no está activa o venció. Volvé a entrar.');
    }
  });

  it('rechaza (401) una fila que ya no existe (borrada, no sólo desactivada)', async () => {
    usuarios = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { valor } = cookieDe();
    const r = await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });
    expect(r.ok).toBe(false);
    expect(consoleError).toHaveBeenCalled();
  });

  // Verificación por mutación: si alguien borra el chequeo de `activo` y
  // deja pasar a cualquiera cuya fila exista, esta prueba (con una fila que
  // SÍ existe pero activo:false) es la que lo nota -- la de "fila
  // inexistente" no alcanza para matar ese mutante.
  it('el rechazo depende de "activo", no sólo de que la fila exista', async () => {
    usuarios[0].activo = false;
    const { valor } = cookieDe();
    const r = await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });
    expect(r.ok).toBe(false);
  });
});

describe('autenticarPeticion — la caché (I6: "menos de un minuto", nunca más allá de su vida útil)', () => {
  it('dentro del minuto de caché, una baja recién hecha todavía no corta el paso', async () => {
    vi.useFakeTimers();
    const { valor } = cookieDe();

    const primero = await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });
    expect(primero.ok).toBe(true);

    usuarios[0].activo = false; // Se desactiva justo después de la primera lectura.

    vi.advanceTimersByTime(30_000); // Dentro de la ventana de caché.
    const segundo = await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });
    expect(segundo.ok).toBe(true);
  });

  it('pasado el minuto, la baja sí corta el paso -- sin esperar a que la cookie caduque (30 días)', async () => {
    vi.useFakeTimers();
    const { valor } = cookieDe();

    await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });
    usuarios[0].activo = false;

    vi.advanceTimersByTime(61_000);
    const r = await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });
    expect(r.ok).toBe(false);
  });

  // La caché NO puede devolver "activo" pasada su vida útil, ni por un
  // instante -- se comprueba justo en el borde (exactamente el TTL, ni un
  // milisegundo más), no bastante después de vencida, donde un `>=` mal
  // puesto por un `>` no se notaría.
  it('en el borde exacto del TTL, la caché ya se trata como vencida', async () => {
    vi.useFakeTimers();
    const { valor } = cookieDe();

    await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });
    usuarios[0].activo = false;

    vi.advanceTimersByTime(60_000); // Exactamente el TTL declarado.
    const r = await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });
    expect(r.ok).toBe(false);
  });

  it('no repite la lectura a la base mientras la entrada sigue vigente en caché', async () => {
    vi.useFakeTimers();
    const { valor } = cookieDe();

    await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });
    expect(lecturasBase).toBe(1);

    vi.advanceTimersByTime(10_000);
    await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });

    // La segunda petición, dentro del minuto, no volvió a tocar la base.
    expect(lecturasBase).toBe(1);
  });

  it('vencida la caché, la siguiente petición sí vuelve a leer la base', async () => {
    vi.useFakeTimers();
    const { valor } = cookieDe();

    await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });
    expect(lecturasBase).toBe(1);

    vi.advanceTimersByTime(61_000);
    await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });

    expect(lecturasBase).toBe(2);
  });
});

describe('autenticarPeticion — I6: un fallo de la base no debe dejar a todo el equipo afuera', () => {
  it('fail-open: un error al leer la base deja pasar con los datos de la cookie, y lo deja escrito en el log', async () => {
    erroresLectura = { message: 'conexión caída' };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { valor } = cookieDe('vendedor');

    const r = await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });

    expect(r).toEqual({ ok: true, vendedor: 'Guillermo Rojas', rol: 'vendedor', id: ID });
    expect(consoleError).toHaveBeenCalled();
  });

  // El criterio elegido es distinto al de `autorizarSuperadmin`
  // (lib/cotizador/equipo.ts), que sí falla cerrado ante el mismo error --
  // ver el comentario de `estadoFrescoDe`. Esta prueba ancla que el
  // fail-open es real y no un efecto colateral de otra cosa: con el mismo
  // error, una persona DESACTIVADA de verdad en la base también pasa,
  // porque la base no pudo confirmar nada -- el costo aceptado a cambio de
  // no tumbar a todo el equipo por un corte transitorio.
  it('fail-open aplica incluso si la persona está de hecho desactivada -- la base no pudo decirlo', async () => {
    usuarios[0].activo = false;
    erroresLectura = { message: 'timeout' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { valor } = cookieDe('vendedor');

    const r = await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });

    expect(r.ok).toBe(true);
  });

  it('un fallo de lectura NO se cachea: la siguiente petición reintenta la base', async () => {
    erroresLectura = { message: 'conexión caída' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { valor } = cookieDe();

    await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });

    // La base se recupera, pero resulta que la persona SÍ estaba
    // desactivada de verdad. Si el fail-open se hubiera cacheado como
    // "activo", esta segunda lectura ni se intentaría.
    erroresLectura = null;
    usuarios[0].activo = false;
    const r = await autenticarPeticion(peticionCon(valor), {}, { requiereCsrf: false });

    expect(r.ok).toBe(false);
  });
});
