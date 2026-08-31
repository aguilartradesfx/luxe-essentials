import { describe, it, expect, vi, beforeEach } from 'vitest';
import { huellaDe } from '@/lib/cotizador/invitaciones';
import { sesionDe } from '@/lib/sesion';

const CLAVE_BUENA = 'clave-larga-de-prueba';

// Doble de la parte de PostgREST que usa la ruta: una lectura por
// `invitacion_hash` (nunca por el enlace crudo) y una escritura
// compare-and-swap por `id` + `invitacion_hash`. Mismo patrón de
// `filtros`/`escrituras` que tests/api-panel.test.ts y
// tests/usuarios-autenticacion.test.ts: se registra cada par
// `[columna, valor]` de CUALQUIER `.eq()` —de lectura o de escritura— y cada
// objeto que llega a un `.update()`.
//
// Ronda de correcciones 1: `fila` no es sólo el dato que se devuelve, es el
// estado compartido que la lectura y la escritura consultan en el momento en
// que cada una corre — no una foto fija tomada al armar el doble. Es lo que
// permite reproducir de verdad la carrera del enlace de un solo uso (ver el
// describe de más abajo): sin esto, el doble no podría distinguir "la
// invitación sigue viva" de "alguien ya la consumió".
type Filtro = [string, string];

let fila: Record<string, unknown> | null;
let errorLectura: { message: string } | null;
let errorEscritura: { message: string } | null;
let filtros: Filtro[];
let escrituras: Record<string, unknown>[];

function filaInvitacionValida(extra: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    correo: 'guillermo@luxeessentialscr.com',
    nombre: 'Guillermo Rojas',
    rol: 'vendedor',
    activo: true,
    clave_hash: null,
    clave_sal: null,
    invitacion_hash: huellaDe('abc'),
    invitacion_expira: new Date(Date.now() + 3_600_000).toISOString(),
    intentos: 3,
    bloqueado_hasta: null,
    ...extra,
  };
}

// Compara los filtros de ESTA llamada contra el estado ACTUAL de `fila` —no
// contra el estado que tenía cuando se leyó—, igual que un WHERE real de
// Postgres evaluado en el momento del UPDATE/SELECT.
function coincideConFilaActual(filtrosLocales: Filtro[]): boolean {
  if (fila === null) return false;
  return filtrosLocales.every(([col, val]) => String((fila as Record<string, unknown>)[col] ?? '') === val);
}

function construirLectura(): any {
  const filtrosLocales: Filtro[] = [];
  const nodo: any = {
    eq: (columna: string, valor: string) => {
      const entrada: Filtro = [columna, String(valor)];
      filtros.push(entrada);
      filtrosLocales.push(entrada);
      return nodo;
    },
    maybeSingle: async () => {
      if (errorLectura) return { data: null, error: errorLectura };
      return { data: coincideConFilaActual(filtrosLocales) ? fila : null, error: null };
    },
  };
  return nodo;
}

// `.update(cambios).eq(...).eq(...).select('id')`. El compare-and-swap real
// vive acá: `.select()` sólo "afecta" (y muta) `fila` si los filtros
// encadenados siguen coincidiendo con su estado actual — exactamente lo que
// hace la cláusula WHERE de un UPDATE de Postgres evaluada fila por fila, con
// el candado que Postgres toma mientras la modifica. Como JS es de un solo
// hilo, la primera llamada a `.select()` que se ejecuta gana la mutación de
// forma atómica: no hay ninguna ventana entre "comprobar" y "escribir" en la
// que la otra petición pueda colarse, igual que en la base real.
function construirEscritura(cambios: Record<string, unknown>): any {
  escrituras.push(cambios);
  const filtrosLocales: Filtro[] = [];
  const nodo: any = {
    eq: (columna: string, valor: string) => {
      const entrada: Filtro = [columna, String(valor)];
      filtros.push(entrada);
      filtrosLocales.push(entrada);
      return nodo;
    },
    select: async () => {
      if (errorEscritura) return { data: null, error: errorEscritura };
      if (!coincideConFilaActual(filtrosLocales)) return { data: [], error: null };
      Object.assign(fila as Record<string, unknown>, cambios);
      return { data: [{ id: (fila as Record<string, unknown>).id }], error: null };
    },
  };
  return nodo;
}

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => construirLectura(),
      update: (cambios: Record<string, unknown>) => construirEscritura(cambios),
    }),
  }),
}));

const { POST } = await import('@/app/api/cotizacion/fijar-clave/route');

function peticion(cuerpo: unknown) {
  return new Request('https://luxeessentialscr.com/api/cotizacion/fijar-clave', {
    method: 'POST',
    body: JSON.stringify(cuerpo),
  });
}

describe('POST /api/cotizacion/fijar-clave', () => {
  beforeEach(() => {
    process.env.LUXE_SESION_SECRETO = 'secreto-de-firma-de-prueba';
    fila = filaInvitacionValida();
    errorLectura = null;
    errorEscritura = null;
    filtros = [];
    escrituras = [];
  });

  it('fija la clave y abre la sesión de una vez', async () => {
    const res = await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.vendedor).toBe('Guillermo Rojas');
    expect(cuerpo.rol).toBe('vendedor');
    expect(typeof cuerpo.csrf).toBe('string');
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('luxe_sesion=');
    // Ronda de correcciones 3: esta ruta es una de las DOS que EMITEN una
    // cookie (la otra es /entrar) — nadie probaba que el id que lleva sea
    // el de la fila que se acaba de autenticar, y no uno fijo pegado por
    // error. Se decodifica con `sesionDe` (la función de verdad, no un
    // split a mano) y se compara contra `fila!.id`, el id real de
    // `filaInvitacionValida()`.
    const cookieValor = (setCookie ?? '').split(';')[0];
    const sesionEmitida = sesionDe(new Request('https://luxeessentialscr.com/x', { headers: { cookie: cookieValor } }));
    expect(sesionEmitida?.id).toBe(fila!.id);
  });

  // El enlace es de un solo uso: si la huella no se borrara, quien lo tuviera
  // podría volver a fijar la clave más adelante y entrar cuando quisiera.
  it('borra la invitación al usarla', async () => {
    await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    expect(escrituras[0]).toMatchObject({ invitacion_hash: null, invitacion_expira: null });
  });

  it('guarda la clave de forma que sirva para entrar después', async () => {
    await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    const { verificarClave } = await import('@/lib/cotizador/credenciales.mjs');
    expect(
      await verificarClave(CLAVE_BUENA, escrituras[0].clave_hash as string, escrituras[0].clave_sal as string),
    ).toBe(true);
  });

  it('rechaza un enlace inexistente sin decir por qué', async () => {
    fila = null;
    const res = await POST(peticion({ enlace: 'no-existe', clave: CLAVE_BUENA }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/venci|no es v[áa]lido/i);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rechaza un enlace vencido, con el mismo 400 y el mismo texto que uno inexistente', async () => {
    fila = filaInvitacionValida({ invitacion_expira: new Date(Date.now() - 3_600_000).toISOString() });
    const res = await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/venci|no es v[áa]lido/i);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  // Tercer caso de rechazo del brief: la cuenta existe y el enlace no venció,
  // pero está desactivada. Tiene que devolver exactamente el mismo 400 y el
  // mismo texto que los otros dos — si se distinguiera, alguien podría usar
  // la respuesta para averiguar qué correos están invitados.
  it('rechaza una cuenta desactivada, con el mismo 400 y el mismo texto', async () => {
    fila = filaInvitacionValida({ activo: false });
    const res = await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/venci|no es v[áa]lido/i);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  // Ronda de correcciones 1, hallazgo importante: las tres pruebas de arriba
  // usan una regex laxa (`/venci|no es v[áa]lido/i`), que sigue en verde
  // aunque alguien parta la rama en DOS mensajes distintos ("Este enlace no
  // es válido." / "Este enlace ya venció."). Esa fuga es justo lo que el
  // diseño nombra tres veces: si los tres casos de rechazo se distinguen,
  // alguien puede usar la respuesta para averiguar qué correos están
  // invitados. Esta prueba no compara contra una regex: compara los tres
  // textos ENTRE SÍ, así que partir la rama en dos mensajes la pone roja sin
  // importar qué tan razonable suene cada uno por separado.
  it('los tres motivos de rechazo devuelven exactamente el mismo texto, no sólo uno parecido', async () => {
    fila = null;
    const resInexistente = await POST(peticion({ enlace: 'no-existe', clave: CLAVE_BUENA }));
    const cuerpoInexistente = await resInexistente.json();

    fila = filaInvitacionValida({ invitacion_expira: new Date(Date.now() - 3_600_000).toISOString() });
    const resVencido = await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    const cuerpoVencido = await resVencido.json();

    fila = filaInvitacionValida({ activo: false });
    const resDesactivada = await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    const cuerpoDesactivada = await resDesactivada.json();

    expect(resInexistente.status).toBe(400);
    expect(resVencido.status).toBe(400);
    expect(resDesactivada.status).toBe(400);
    expect(cuerpoVencido.error).toBe(cuerpoInexistente.error);
    expect(cuerpoDesactivada.error).toBe(cuerpoInexistente.error);
  });

  it('exige una clave de al menos 10 caracteres', async () => {
    const res = await POST(peticion({ enlace: 'abc', clave: 'corta' }));
    expect(res.status).toBe(400);
  });

  // Ronda de correcciones 1, hallazgo menor: 'corta' tiene 5 caracteres, así
  // que atrapa un mínimo corrido a 4 o a 5, pero deja pasar cualquier mínimo
  // entre 6 y 9 sin que ninguna prueba se entere. Estas dos fijan la
  // frontera exacta que pide el brief (10).
  it('rechaza una clave de exactamente 9 caracteres (frontera del mínimo)', async () => {
    const res = await POST(peticion({ enlace: 'abc', clave: '123456789' }));
    expect(res.status).toBe(400);
  });

  it('acepta una clave de exactamente 10 caracteres (frontera del mínimo)', async () => {
    const res = await POST(peticion({ enlace: 'abc', clave: '1234567890' }));
    expect(res.status).toBe(200);
  });

  // Busca por huella, no por enlace: el valor crudo nunca toca la consulta.
  it('consulta por la huella y no por el enlace', async () => {
    await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    expect(filtros).toContainEqual(['invitacion_hash', huellaDe('abc')]);
    expect(JSON.stringify(filtros)).not.toContain('"abc"');
  });

  // Un fallo de base es un 500, no un 400: confundirlo con "enlace inválido"
  // esconde una caída real detrás de un mensaje que no tiene nada que ver.
  it('un fallo de lectura de la base es 500, no 400', async () => {
    errorLectura = { message: 'conexión caída' };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    expect(res.status).toBe(500);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('un fallo de escritura de la base es 500, no 400', async () => {
    errorEscritura = { message: 'no se pudo escribir' };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA }));
    expect(res.status).toBe(500);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // Ronda de correcciones 1, hallazgo importante: entre la lectura de la
  // invitación y la escritura que la consume hay una derivación de scrypt
  // REAL —no mockeada acá a propósito, porque la ventana de la carrera ES ese
  // tiempo (~100-400 ms, ver el comentario de N en credenciales.mjs). Dos
  // peticiones concurrentes con el mismo enlace: las dos leen la fila
  // vigente (ninguna escribió todavía), las dos derivan su propio hash, y
  // sólo una puede ganar la escritura condicionada por `invitacion_hash` —la
  // otra encuentra la invitación ya consumida (cero filas afectadas) y se
  // rechaza igual que un enlace inválido. Sin el `.eq('invitacion_hash', ...)`
  // de la escritura (revertido a mano para verificar), las dos escrituras
  // sólo filtran por `id` —que no cambia— y las dos "ganan": esta prueba se
  // pone roja con `[200, 200]` en vez de `[200, 400]`.
  it(
    'el enlace es de un solo uso: dos peticiones concurrentes con el mismo enlace, sólo una fija la clave',
    async () => {
      const [res1, res2] = await Promise.all([
        POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA })),
        POST(peticion({ enlace: 'abc', clave: CLAVE_BUENA })),
      ]);

      const estados = [res1.status, res2.status].sort((a, b) => a - b);
      expect(estados).toEqual([200, 400]);

      // Ni cero cookies (algo se rompió) ni dos (las dos peticiones se
      // creyeron dueñas del enlace) — exactamente una.
      const cookies = [res1.headers.get('set-cookie'), res2.headers.get('set-cookie')];
      expect(cookies.filter((c) => c !== null)).toHaveLength(1);
    },
    10_000,
  );
});
