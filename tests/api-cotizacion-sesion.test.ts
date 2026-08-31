import { describe, it, expect, vi, beforeEach } from 'vitest';

// Tarea 4 (fase 3): el endpoint de entrada ya no acepta la clave compartida:
// la cambia por la tabla de usuarios. Se moquea `@/lib/cotizador/usuarios`
// para probar la ruta sin base de datos — la lógica de intentos ya tiene sus
// propias pruebas en tests/usuarios-autenticacion.test.ts.
//
// Ronda de correcciones 1 (Tarea 3, invitaciones y roles): sólo se
// reemplaza `autenticarUsuario`. El resto del módulo real se conserva vía
// `importOriginal` — en particular `ROLES`, que `lib/sesion.ts` importa en
// tiempo de ejecución (no sólo como tipo) para validar el rol de una
// cookie. Un mock que sólo devolviera `{ autenticarUsuario }` dejaría ese
// import en `undefined` y tumbaría en runtime cualquier prueba de este
// archivo que emita o lea una sesión.
vi.mock('@/lib/cotizador/usuarios', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cotizador/usuarios')>();
  return {
    ...real,
    autenticarUsuario: vi.fn(),
  };
});

// Ronda de correcciones 1 (Tarea 6): las siete pruebas de panel-sesion.test.ts
// son unitarias sobre lib/sesion.ts — no ejercitan ni una sola ruta real. El
// revisor probó tres mutantes sobre el código de las rutas y las 529 pruebas
// de entonces seguían en verde:
//   1. Quitar el bloque anti-CSRF entero de app/api/cotizacion/route.ts.
//   2. Poner `frame-ancestors *` en next.config.ts (cubierto aparte en
//      tests/next-config-cabeceras.test.ts).
//   3. Que las rutas de lectura dejen de aceptar la cookie.
// Y por construcción, quitar la validación de clave de /entrar tampoco
// rompía nada, porque esa ruta no tenía archivo de pruebas. Este archivo
// cierra las cuatro grietas.

// Tarea 12: `notaDeCotizacion` queda real vía `importOriginal` (es pura y
// local); sólo se mockea `crearEstimate`. `agregarNota` se mockea aparte
// (ver abajo) para que ninguna prueba de este archivo dispare una llamada
// de red real cuando el correo "sale".
vi.mock('@/lib/cotizador/ghl', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cotizador/ghl')>();
  return {
    ...real,
    crearEstimate: vi.fn().mockResolvedValue({ ok: true, estimateId: 'est-1', contactId: 'contacto-ghl-1' }),
  };
});
vi.mock('@/lib/agente/acciones', () => ({
  agregarNota: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/cotizador/documento', () => ({
  renderizarCotizacion: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7 falso')),
}));
vi.mock('@/lib/cotizador/almacen', () => ({
  guardarPdf: vi.fn().mockResolvedValue({ ok: true, ruta: '2026/COT-1-abc.pdf' }),
  enlaceFirmado: vi.fn().mockResolvedValue({ ok: true, url: 'https://firmada' }),
}));
vi.mock('@/lib/cotizador/correo', () => ({
  enviarCotizacion: vi.fn().mockResolvedValue({ ok: true, resendId: 're_1' }),
}));
vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => ({ data: { id: 'cot-1', numero: 'COT-2026-0001' }, error: null }),
        }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

const { POST: postCotizacion } = await import('@/app/api/cotizacion/route');
const { POST: postCatalogo } = await import('@/app/api/cotizacion/catalogo/route');
const { POST: postPrevisualizar } = await import('@/app/api/cotizacion/previsualizar/route');
const { POST: postBorradores } = await import('@/app/api/cotizacion/borradores/route');
const { POST: postEntrar } = await import('@/app/api/cotizacion/entrar/route');
const { emitirSesion } = await import('@/lib/sesion');
const { autenticarUsuario } = await import('@/lib/cotizador/usuarios');

function peticion(url: string, cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabeceras },
    body: JSON.stringify(cuerpo),
  });
}

const cotizacionValida = {
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
  lineas: [{ skuId: 'set-600-king', cantidad: 16 }],
};

const previsualizarValida = { lineas: [{ skuId: 'set-600-king', cantidad: 16 }] };

describe('rutas de app/api/cotizacion/* — sesión por cookie y CSRF', () => {
  beforeEach(() => {
    process.env.LUXE_SESION_SECRETO = 'secreta';
  });

  describe('POST /api/cotizacion (escribe): exige CSRF cuando entra por cookie', () => {
    it('mata el mutante 1: cookie válida SIN el token anti-CSRF en la cabecera → 401', async () => {
      const { cookie } = emitirSesion('Guillermo Rojas', 'vendedor', 'aaaaaaaa-0000-4000-8000-000000000001');
      const valor = cookie.split(';')[0];
      const res = await postCotizacion(
        peticion('http://localhost/api/cotizacion', cotizacionValida, { cookie: valor }),
      );
      expect(res.status).toBe(401);
    });

    it('cookie válida con un token anti-CSRF que no coincide → 401', async () => {
      const { cookie } = emitirSesion('Guillermo Rojas', 'vendedor', 'aaaaaaaa-0000-4000-8000-000000000001');
      const valor = cookie.split(';')[0];
      const res = await postCotizacion(
        peticion('http://localhost/api/cotizacion', cotizacionValida, {
          cookie: valor,
          'x-csrf-token': 'inventado',
        }),
      );
      expect(res.status).toBe(401);
    });

    it('cookie válida CON el token anti-CSRF correcto → pasa (200)', async () => {
      const { cookie, csrf } = emitirSesion('Guillermo Rojas', 'vendedor', 'aaaaaaaa-0000-4000-8000-000000000001');
      const valor = cookie.split(';')[0];
      const res = await postCotizacion(
        peticion('http://localhost/api/cotizacion', cotizacionValida, {
          cookie: valor,
          'x-csrf-token': csrf,
        }),
      );
      expect(res.status).toBe(200);
    });

    // Fase 3: la clave compartida ya no es una credencial. Antes esta prueba
    // confirmaba que mandarla en el cuerpo bastaba para saltarse la cookie y
    // el CSRF (era el respaldo documentado en autenticarPeticion). Esa vía se
    // cerró a propósito con esta tarea: mandarla ahora no hace nada, y la
    // petición cae en el mismo 401 que sin ningún dato de sesión.
    it('la clave en el cuerpo ya no autentica: sin cookie, sigue dando 401', async () => {
      const res = await postCotizacion(
        peticion('http://localhost/api/cotizacion', { ...cotizacionValida, clave: 'secreta' }),
      );
      expect(res.status).toBe(401);
    });

    it('sin clave y sin cookie → 401', async () => {
      const res = await postCotizacion(peticion('http://localhost/api/cotizacion', cotizacionValida));
      expect(res.status).toBe(401);
    });
  });

  describe('rutas de solo lectura: aceptan la cookie sin exigir CSRF', () => {
    it('mata el mutante 3: /catalogo con cookie válida y sin clave en el cuerpo → pasa (200)', async () => {
      const { cookie } = emitirSesion('Guillermo Rojas', 'vendedor', 'aaaaaaaa-0000-4000-8000-000000000001');
      const valor = cookie.split(';')[0];
      const res = await postCatalogo(peticion('http://localhost/api/cotizacion/catalogo', {}, { cookie: valor }));
      expect(res.status).toBe(200);
    });

    it('/previsualizar con cookie válida y sin clave en el cuerpo → pasa (200)', async () => {
      const { cookie } = emitirSesion('Guillermo Rojas', 'vendedor', 'aaaaaaaa-0000-4000-8000-000000000001');
      const valor = cookie.split(';')[0];
      const res = await postPrevisualizar(
        peticion('http://localhost/api/cotizacion/previsualizar', previsualizarValida, { cookie: valor }),
      );
      expect(res.status).toBe(200);
    });

    it('/borradores con cookie válida y sin clave en el cuerpo → pasa (200)', async () => {
      const { cookie } = emitirSesion('Guillermo Rojas', 'vendedor', 'aaaaaaaa-0000-4000-8000-000000000001');
      const valor = cookie.split(';')[0];
      const res = await postBorradores(
        peticion('http://localhost/api/cotizacion/borradores', {}, { cookie: valor }),
      );
      expect(res.status).toBe(200);
    });

    it('/catalogo sin clave y sin cookie → 401', async () => {
      const res = await postCatalogo(peticion('http://localhost/api/cotizacion/catalogo', {}));
      expect(res.status).toBe(401);
    });

    it('/previsualizar con una cookie inventada (no una sesión real) → 401', async () => {
      const res = await postPrevisualizar(
        peticion('http://localhost/api/cotizacion/previsualizar', previsualizarValida, {
          cookie: 'luxe_sesion=inventado',
        }),
      );
      expect(res.status).toBe(401);
    });
  });

  // Fase 3: /entrar ya no valida una clave compartida contra `LUXE_TALLER_CLAVE`
  // — autentica contra la tabla de usuarios (`autenticarUsuario`, moqueada
  // arriba). Las pruebas de forma del endpoint (400/401/429/500, csrf y
  // vendedor en la respuesta) viven en el describe de más abajo
  // ('POST /api/cotizacion/entrar'); estas tres se conservan porque cubren
  // algo que ese describe no repite: que un rechazo NO deja Set-Cookie, que
  // un éxito trae SameSite=None, y que un rechazo queda en el log.
  describe('POST /api/cotizacion/entrar', () => {
    beforeEach(() => {
      vi.mocked(autenticarUsuario).mockReset();
    });

    it('con credenciales incorrectas → 401 y sin cabecera Set-Cookie', async () => {
      vi.mocked(autenticarUsuario).mockResolvedValue({ ok: false, motivo: 'credenciales' });
      const res = await postEntrar(
        peticion('http://localhost/api/cotizacion/entrar', { correo: 'guillermo@luxeessentialscr.com', clave: 'otra' }),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('con credenciales correctas → 200, con csrf en el cuerpo y Set-Cookie con SameSite=None', async () => {
      vi.mocked(autenticarUsuario).mockResolvedValue({ ok: true, id: 'aaaaaaaa-0000-4000-8000-000000000001', nombre: 'Guillermo Rojas', rol: 'vendedor' });
      const res = await postEntrar(
        peticion('http://localhost/api/cotizacion/entrar', { correo: 'guillermo@luxeessentialscr.com', clave: 'secreta' }),
      );
      expect(res.status).toBe(200);
      const cuerpo = await res.json();
      expect(cuerpo.ok).toBe(true);
      // Ronda de correcciones 1 — menor: sin esta línea, borrar `rol:
      // resultado.rol` de la respuesta de la ruta pasaba en verde igual.
      expect(cuerpo.rol).toBe('vendedor');
      expect(typeof cuerpo.csrf).toBe('string');
      expect(cuerpo.csrf.length).toBeGreaterThan(0);
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain('luxe_sesion=');
      expect(setCookie).toMatch(/SameSite=None/i);
    });

    it('registra en consola un rechazo de credenciales (hace visible un ataque de fuerza bruta)', async () => {
      vi.mocked(autenticarUsuario).mockResolvedValue({ ok: false, motivo: 'credenciales' });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      await postEntrar(peticion('http://localhost/api/cotizacion/entrar', { correo: 'guillermo@luxeessentialscr.com', clave: 'otra' }));
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });
});

// Tarea 4 (fase 3): `autenticarUsuario` y `postEntrar` ya están importados
// arriba, junto con el resto de las rutas de este archivo — se reutilizan acá
// en vez de reimportarlos con otro nombre.
function peticionEntrada(cuerpo: unknown) {
  return new Request('https://luxeessentialscr.com/api/cotizacion/entrar', {
    method: 'POST',
    body: JSON.stringify(cuerpo),
  });
}

describe('POST /api/cotizacion/entrar', () => {
  beforeEach(() => {
    vi.mocked(autenticarUsuario).mockReset();
    process.env.LUXE_SESION_SECRETO = 'secreto-de-firma';
  });

  // Ronda de correcciones 1: el nombre moqueado es 'Marta Vargas' —
  // deliberadamente distinto del 'Guillermo Rojas' que usa el resto del
  // archivo (y que fue el valor fijo provisional de esta misma ruta antes de
  // esta tarea). Si alguien reintrodujera `emitirSesion('Guillermo Rojas', 'vendedor', 'aaaaaaaa-0000-4000-8000-000000000001')`
  // a mano en la ruta, esta prueba (y sólo esta, entre las de este archivo)
  // lo notaría: es la única que compara `vendedor` contra un nombre que no
  // coincide con esa regresión. El `toHaveBeenCalledWith` además fija el
  // ORDEN de los argumentos: invertir `correo`/`clave` en la llamada a
  // `autenticarUsuario` (que en producción significa "nadie puede entrar")
  // pasaba en verde antes de este ajuste, porque el mock resuelve igual sin
  // mirar con qué lo llamaron.
  it('emite una sesión con el nombre real del vendedor autenticado, en el orden correcto de argumentos', async () => {
    vi.mocked(autenticarUsuario).mockResolvedValue({ ok: true, id: 'aaaaaaaa-0000-4000-8000-000000000001', nombre: 'Marta Vargas', rol: 'vendedor' });
    const res = await postEntrar(peticionEntrada({ correo: 'guillermo@luxeessentialscr.com', clave: 'x' }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.vendedor).toBe('Marta Vargas');
    expect(cuerpo.rol).toBe('vendedor');
    expect(typeof cuerpo.csrf).toBe('string');
    expect(res.headers.get('set-cookie')).toContain('luxe_sesion=');
    expect(autenticarUsuario).toHaveBeenCalledWith('guillermo@luxeessentialscr.com', 'x', expect.anything());
  });

  it('rechaza credenciales incorrectas con 401', async () => {
    vi.mocked(autenticarUsuario).mockResolvedValue({ ok: false, motivo: 'credenciales' });
    const res = await postEntrar(peticionEntrada({ correo: 'guillermo@luxeessentialscr.com', clave: 'mala' }));
    expect(res.status).toBe(401);
  });

  it('distingue una cuenta bloqueada, con 429 y un mensaje propio', async () => {
    vi.mocked(autenticarUsuario).mockResolvedValue({ ok: false, motivo: 'bloqueado' });
    const res = await postEntrar(peticionEntrada({ correo: 'guillermo@luxeessentialscr.com', clave: 'x' }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/bloquead/i);
  });

  // La clave compartida era la credencial de entrada hasta esta fase. Que siga
  // sirviendo dejaría abierto exactamente el hueco que la fase cierra.
  it('ya no acepta la clave compartida', async () => {
    vi.mocked(autenticarUsuario).mockResolvedValue({ ok: false, motivo: 'credenciales' });
    const res = await postEntrar(peticionEntrada({ clave: 'secreto-de-firma' }));
    expect(res.status).toBe(400);
    expect(vi.mocked(autenticarUsuario)).not.toHaveBeenCalled();
  });

  it('rechaza un correo vacío con 400', async () => {
    const res = await postEntrar(peticionEntrada({ correo: '', clave: 'x' }));
    expect(res.status).toBe(400);
  });

  it('devuelve 500, no 401, si la base falla', async () => {
    vi.mocked(autenticarUsuario).mockRejectedValue(new Error('conexión caída'));
    const res = await postEntrar(peticionEntrada({ correo: 'guillermo@luxeessentialscr.com', clave: 'x' }));
    expect(res.status).toBe(500);
  });

  // Revisión final, M5: el correo no puede quedar en los logs, ni entero ni
  // truncado. El modo de fallo clásico de un formulario de acceso es escribir
  // la clave en el campo de correo, y en ese caso hasta tres caracteres son
  // pedazos de una credencial real, retenidos y buscables en Vercel.
  it('no deja el correo en el log de rechazo, ni siquiera un prefijo', async () => {
    vi.mocked(autenticarUsuario).mockResolvedValue({ ok: false, motivo: 'credenciales' });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Lo que se teclea acá es, en el caso que importa, una clave real.
    await postEntrar(peticionEntrada({ correo: 'Turrialba-2026@luxeessentialscr.com', clave: 'x' }));

    const registrado = consoleError.mock.calls.flat().join(' ');
    expect(registrado).not.toContain('Turrialba-2026@luxeessentialscr.com');
    expect(registrado).not.toContain('Tur');
    // Sigue habiendo con qué distinguir intentos contra cuentas distintas.
    expect(registrado).toMatch(/[0-9a-f]{8}/);
    consoleError.mockRestore();
  });

  // Revisión final, M7: `emitirSesion` estaba fuera de todo `try`. Si faltara
  // el secreto en Vercel —el caso exacto de un despliegue nuevo— la ruta
  // devolvía un 500 genérico de Next, sin una sola línea que dijera por qué.
  it('si falta LUXE_SESION_SECRETO, devuelve 500 con un diagnóstico explícito en el log', async () => {
    vi.mocked(autenticarUsuario).mockResolvedValue({ ok: true, id: 'aaaaaaaa-0000-4000-8000-000000000001', nombre: 'Guillermo Rojas', rol: 'vendedor' });
    delete process.env.LUXE_SESION_SECRETO;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postEntrar(peticionEntrada({ correo: 'guillermo@luxeessentialscr.com', clave: 'x' }));

    expect(res.status).toBe(500);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(consoleError.mock.calls.flat().join(' ')).toContain('LUXE_SESION_SECRETO');
    consoleError.mockRestore();
  });
});

// Revisión final, Importante 3: no existía ninguna ruta que caducara la
// cookie. En una computadora compartida el segundo vendedor no tenía forma de
// dejar de ser el primero — la cookie es `HttpOnly`, dura 30 días, y ningún
// código del navegador podía borrarla.
describe('POST /api/cotizacion/salir', () => {
  beforeEach(() => {
    process.env.LUXE_SESION_SECRETO = 'secreto-de-firma';
  });

  it('caduca la cookie con Max-Age=0 y los mismos atributos con que se emitió', async () => {
    const { POST: postSalir } = await import('@/app/api/cotizacion/salir/route');
    const { cookie: emitida } = emitirSesion('Guillermo Rojas', 'vendedor', 'aaaaaaaa-0000-4000-8000-000000000001');

    const res = await postSalir();

    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('luxe_sesion=');
    expect(setCookie).toMatch(/Max-Age=0\b/);

    // Los atributos de identidad tienen que coincidir con los de la cookie de
    // entrada: si `Path`, `Secure`, `SameSite` o `Partitioned` no son los
    // mismos, el navegador la trata como otra cookie y no borra nada — que
    // dentro del iframe de GoHighLevel (donde `Partitioned` es obligatoria)
    // sería un "Salir" que no saca a nadie.
    for (const atributo of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=None', 'Partitioned']) {
      expect(setCookie).toContain(atributo);
      expect(emitida).toContain(atributo);
    }
  });

  it('el valor que deja no vale como sesión ni siquiera si el navegador ignora Max-Age', async () => {
    const { POST: postSalir } = await import('@/app/api/cotizacion/salir/route');
    const res = await postSalir();
    const valor = (res.headers.get('set-cookie') ?? '').split(';')[0];

    const req = new Request('https://luxeessentialscr.com/api/cotizacion/listado', {
      headers: { cookie: valor },
    });
    const { sesionValida } = await import('@/lib/sesion');
    expect(sesionValida(req)).toBe(false);
  });
});

describe('autenticarPeticion', () => {
  it('devuelve el vendedor de la sesión', async () => {
    const { emitirSesion } = await import('@/lib/sesion');
    const { autenticarPeticion } = await import('@/lib/autenticacion-cotizador');
    const { cookie } = emitirSesion('Guillermo Rojas', 'vendedor', 'aaaaaaaa-0000-4000-8000-000000000001');
    const req = new Request('https://luxeessentialscr.com/api/cotizacion/listado', {
      headers: { cookie: cookie.split(';')[0] },
    });
    const r = autenticarPeticion(req, {}, { requiereCsrf: false });
    expect(r).toEqual({ ok: true, vendedor: 'Guillermo Rojas', rol: 'vendedor', id: 'aaaaaaaa-0000-4000-8000-000000000001' });
  });

  it('ya no acepta la clave compartida en el cuerpo', async () => {
    const { autenticarPeticion } = await import('@/lib/autenticacion-cotizador');
    const req = new Request('https://luxeessentialscr.com/api/cotizacion/listado');
    const r = autenticarPeticion(req, { clave: 'secreto-de-firma' }, { requiereCsrf: false });
    expect(r.ok).toBe(false);
  });
});
