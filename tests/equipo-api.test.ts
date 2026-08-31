import { describe, it, expect, vi, beforeEach } from 'vitest';

// Tarea 5 (invitaciones y roles): las cuatro rutas de app/api/equipo/*. La
// promesa central de la fase es que `autorizarSuperadmin` relee la base y
// nunca confía en el rol de la cookie —ver el comentario grande en
// lib/cotizador/equipo.ts—, así que las pruebas que ejercitan esa promesa
// arman una cookie VÁLIDA de verdad (firmada por `emitirSesion`, con el
// token anti-CSRF que le corresponde) y sólo hacen diferir la FILA de la
// base. Si la cookie fuera inválida o el CSRF faltara, la ruta rechazaría
// por ese motivo primero y la prueba no probaría nada.
//
// Se mockea `@/lib/cotizador/correo-invitacion` entero (mismo criterio que
// tests/api-cotizacion-sesion.test.ts con `@/lib/cotizador/correo`): ninguna
// prueba de este archivo llama a la API de Resend de verdad. La propia
// función `enviarInvitacion` ya tiene su cobertura de `fetchImpl` inyectado
// en tests/correo-invitacion.test.ts; acá sólo importa CUÁNDO se llama, con
// qué correo y qué pasa cuando falla.
let resendFalla = false;
const llamadasCorreo: { para: string; nombre: string; enlace: string }[] = [];

vi.mock('@/lib/cotizador/correo-invitacion', () => ({
  enviarInvitacion: vi.fn(async (p: { para: string; nombre: string; enlace: string }) => {
    llamadasCorreo.push(p);
    if (resendFalla) return { ok: false, error: 'Resend simulado: fallo forzado por la prueba.' };
    return { ok: true, resendId: 're_test' };
  }),
}));

type Fila = {
  id: string;
  correo: string;
  nombre: string;
  rol: 'vendedor' | 'superadmin';
  activo: boolean;
  clave_hash: string | null;
  clave_sal: string | null;
  invitacion_hash: string | null;
  invitacion_expira: string | null;
  ultimo_acceso: string | null;
};

// Estado compartido: un arreglo en memoria que hace de tabla. Se referencia
// desde el doble de Supabase de más abajo y directamente desde las pruebas
// (para sembrar filas o inspeccionar lo que quedó escrito), igual que
// `fila` en tests/api-cotizacion-sesion.test.ts.
let filas: Fila[];
let erroresLectura: { message: string } | null;
let erroresInsert: { code?: string; message: string } | null;
let erroresEscritura: { message: string } | null;
let siguienteId: number;

function coincide(fila: Fila, filtros: [string, unknown][]): boolean {
  return filtros.every(([columna, valor]) => (fila as Record<string, unknown>)[columna] === valor);
}

function construirSelect(): any {
  const filtros: [string, unknown][] = [];
  const nodo: any = {
    eq(columna: string, valor: unknown) {
      filtros.push([columna, valor]);
      return nodo;
    },
    order() {
      return nodo;
    },
    maybeSingle: async () => {
      if (erroresLectura) return { data: null, error: erroresLectura };
      return { data: filas.find((f) => coincide(f, filtros)) ?? null, error: null };
    },
    // Thenable: cubre `.select(...).eq(...).eq(...)` (el conteo de
    // superadmins en `cambiarEstado`) y `.select(...).order(...)` (el
    // listado completo), ninguno de los cuales llama a `.maybeSingle()`.
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      const promesa = (async () => {
        if (erroresLectura) return { data: null, error: erroresLectura };
        return { data: filas.filter((f) => coincide(f, filtros)), error: null };
      })();
      return promesa.then(resolve, reject);
    },
  };
  return nodo;
}

function construirInsert(cambios: Record<string, unknown>): any {
  return (async () => {
    if (erroresInsert) return { error: erroresInsert };
    const correo = String(cambios.correo);
    if (filas.some((f) => f.correo === correo)) {
      // Mismo código que devuelve Postgres al chocar contra el índice único
      // sobre `lower(correo)` (migración 0014).
      return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
    }
    siguienteId += 1;
    filas.push({
      id: `nuevo-${siguienteId}`,
      correo,
      nombre: String(cambios.nombre),
      rol: cambios.rol as Fila['rol'],
      activo: Boolean(cambios.activo),
      clave_hash: null,
      clave_sal: null,
      invitacion_hash: (cambios.invitacion_hash as string) ?? null,
      invitacion_expira: (cambios.invitacion_expira as string) ?? null,
      ultimo_acceso: null,
    });
    return { error: null };
  })();
}

function construirUpdate(cambios: Record<string, unknown>): any {
  const filtros: [string, unknown][] = [];
  const nodo: any = {
    eq(columna: string, valor: unknown) {
      filtros.push([columna, valor]);
      return nodo;
    },
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      const promesa = (async () => {
        if (erroresEscritura) return { error: erroresEscritura };
        for (const f of filas) {
          if (coincide(f, filtros)) Object.assign(f, cambios);
        }
        return { error: null };
      })();
      return promesa.then(resolve, reject);
    },
  };
  return nodo;
}

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => construirSelect(),
      insert: (cambios: Record<string, unknown>) => construirInsert(cambios),
      update: (cambios: Record<string, unknown>) => construirUpdate(cambios),
    }),
  }),
}));

const { POST: postListar } = await import('@/app/api/equipo/listar/route');
const { POST: postInvitar } = await import('@/app/api/equipo/invitar/route');
const { POST: postReenviar } = await import('@/app/api/equipo/reenviar/route');
const { POST: postEstado } = await import('@/app/api/equipo/estado/route');
const { emitirSesion } = await import('@/lib/sesion');
const { huellaDe } = await import('@/lib/cotizador/invitaciones');

function peticion(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return new Request('https://luxeessentialscr.com/api/equipo', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabeceras },
    body: JSON.stringify(cuerpo),
  });
}

// Cookie firmada de verdad, con el csrf que le corresponde. `rol` es el que
// declara la COOKIE — no tiene por qué coincidir con lo que diga la base;
// eso es justo lo que las pruebas de la promesa central necesitan poder
// separar.
function sesion(nombre: string, rol: 'vendedor' | 'superadmin' = 'superadmin') {
  const { cookie, csrf } = emitirSesion(nombre, rol);
  return { cookie: cookie.split(';')[0], csrf };
}

function filaBase(extra: Partial<Fila> = {}): Fila {
  return {
    id: 'u1',
    correo: 'ana@luxeessentialscr.com',
    nombre: 'Ana Solano',
    rol: 'superadmin',
    activo: true,
    clave_hash: 'hash-x',
    clave_sal: 'sal-x',
    invitacion_hash: null,
    invitacion_expira: null,
    ultimo_acceso: '2026-08-01T00:00:00.000Z',
    ...extra,
  };
}

const UUID_U1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const UUID_U2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const UUID_INVITADA = 'bbbbbbbb-0000-4000-8000-000000000001';
const UUID_ACTIVA = 'cccccccc-0000-4000-8000-000000000001';
const UUID_INEXISTENTE = 'dddddddd-0000-4000-8000-000000000001';

beforeEach(() => {
  process.env.LUXE_SESION_SECRETO = 'secreto-de-firma-de-prueba';
  filas = [filaBase({ id: UUID_U1 })];
  erroresLectura = null;
  erroresInsert = null;
  erroresEscritura = null;
  siguienteId = 0;
  resendFalla = false;
  llamadasCorreo.length = 0;
});

describe('autorizacion: el rol de la cookie no autoriza nada', () => {
  it('un superadmin activo, de verdad en la base, entra (200) — control de que el guardia no rechaza a todos', async () => {
    const { cookie } = sesion('Ana Solano');
    const res = await postListar(peticion({}, { cookie }));
    expect(res.status).toBe(200);
  });

  // La promesa central de la fase: la cookie firmada dice 'superadmin' —es
  // una cookie VÁLIDA, no forjada— pero la fila de esa persona en la base
  // dice 'vendedor'. Tiene que rechazarse igual.
  it('rechaza a un vendedor aunque su cookie firmada diga superadmin', async () => {
    filas.push(filaBase({ id: 'u-vendedor', nombre: 'Beto Vendedor', correo: 'beto@luxeessentialscr.com', rol: 'vendedor' }));
    const { cookie } = sesion('Beto Vendedor');
    const res = await postListar(peticion({}, { cookie }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('No tenés permiso para administrar el equipo.');
  });

  // Cookie válida con rol 'superadmin' Y la base también dice 'superadmin'
  // para ese nombre — pero `activo: false`. Sólo la desactivación distingue
  // este caso del de control de arriba.
  it('rechaza a un superadmin desactivado en la base', async () => {
    filas = [filaBase({ id: 'u-baja', nombre: 'Carla Baja', correo: 'carla@luxeessentialscr.com', activo: false })];
    const { cookie } = sesion('Carla Baja');
    const res = await postListar(peticion({}, { cookie }));
    expect(res.status).toBe(403);
  });

  it('un vendedor real (cookie y base de acuerdo) también recibe 403', async () => {
    filas.push(filaBase({ id: 'u-real', nombre: 'Dario Real', correo: 'dario@luxeessentialscr.com', rol: 'vendedor' }));
    const { cookie } = sesion('Dario Real', 'vendedor');
    const res = await postListar(peticion({}, { cookie }));
    expect(res.status).toBe(403);
  });

  it('sin cookie -> 401, no 403 (nunca llega a autorizar)', async () => {
    const res = await postListar(peticion({}));
    expect(res.status).toBe(401);
  });

  it('nadie sin cookie manda un correo: el rechazo de autenticacion/autorizacion nunca invita a nadie', async () => {
    await postInvitar(peticion({ correo: 'x@y.cr', nombre: 'X', rol: 'vendedor' }));
    expect(llamadasCorreo).toHaveLength(0);
  });
});

describe('CSRF: las tres rutas que escriben lo exigen; listar no', () => {
  it('invitar sin token anti-CSRF -> 401', async () => {
    const { cookie } = sesion('Ana Solano');
    const res = await postInvitar(peticion({ correo: 'nuevo@luxe.cr', nombre: 'Nueva Persona', rol: 'vendedor' }, { cookie }));
    expect(res.status).toBe(401);
  });

  it('reenviar sin token anti-CSRF -> 401', async () => {
    filas.push(filaBase({ id: UUID_INVITADA, correo: 'invitada@luxe.cr', nombre: 'Invitada', rol: 'vendedor', clave_hash: null, clave_sal: null, invitacion_expira: new Date(Date.now() + 3_600_000).toISOString() }));
    const { cookie } = sesion('Ana Solano');
    const res = await postReenviar(peticion({ id: UUID_INVITADA }, { cookie }));
    expect(res.status).toBe(401);
  });

  it('estado sin token anti-CSRF -> 401', async () => {
    const { cookie } = sesion('Ana Solano');
    const res = await postEstado(peticion({ id: UUID_U1, activo: false }, { cookie }));
    expect(res.status).toBe(401);
  });

  it('listar SIN token anti-CSRF pasa igual (200): es de solo lectura', async () => {
    const { cookie } = sesion('Ana Solano');
    const res = await postListar(peticion({}, { cookie }));
    expect(res.status).toBe(200);
  });
});

describe('el ultimo superadmin activo no se puede tocar', () => {
  it('no deja desactivar al ultimo superadmin activo (409)', async () => {
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postEstado(peticion({ id: UUID_U1, activo: false }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/último superadmin/i);
    // Y la fila no se tocó: sigue activa.
    expect(filas.find((f) => f.id === UUID_U1)?.activo).toBe(true);
  });

  it('no deja degradar al ultimo superadmin activo (409)', async () => {
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postEstado(peticion({ id: UUID_U1, rol: 'vendedor' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/último superadmin/i);
    expect(filas.find((f) => f.id === UUID_U1)?.rol).toBe('superadmin');
  });

  // Control: con DOS superadmins activos, desactivar a uno de ellos sí
  // procede. Sin esta prueba, un guardia que rechazara SIEMPRE (sin contar
  // de verdad) pasaría igual las dos de arriba.
  it('con dos superadmins activos, sí se puede desactivar a uno (200)', async () => {
    filas.push(filaBase({ id: UUID_U2, correo: 'beto@luxeessentialscr.com', nombre: 'Beto Superadmin' }));
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postEstado(peticion({ id: UUID_U1, activo: false }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(200);
    expect(filas.find((f) => f.id === UUID_U1)?.activo).toBe(false);
  });

  it('degradar a un vendedor cualquiera nunca choca con la guarda (200)', async () => {
    filas.push(filaBase({ id: UUID_U2, correo: 'vendedor@luxeessentialscr.com', nombre: 'Vendedor Cualquiera', rol: 'vendedor' }));
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postEstado(peticion({ id: UUID_U2, activo: false }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(200);
  });

  // El conteo tiene que filtrar por `activo: true` de verdad, no sólo por
  // `rol: 'superadmin'`. Hay DOS filas con rol superadmin, pero una ya está
  // desactivada — sigue habiendo un solo superadmin ACTIVO, así que la
  // guarda tiene que rechazar igual. Si el conteo olvidara el filtro de
  // `activo`, esta prueba lo detecta: contaría 2 y dejaría pasar.
  it('sigue siendo el ultimo superadmin ACTIVO aunque exista otra fila superadmin ya desactivada', async () => {
    filas.push(
      filaBase({ id: UUID_U2, correo: 'inactivo@luxeessentialscr.com', nombre: 'Superadmin Inactivo', activo: false }),
    );
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postEstado(peticion({ id: UUID_U1, activo: false }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(409);
    expect(filas.find((f) => f.id === UUID_U1)?.activo).toBe(true);
  });

  // Mismo argumento, del otro lado: el conteo tiene que filtrar por
  // `rol: 'superadmin'` de verdad, no sólo por `activo: true`. Hay otra fila
  // activa, pero es vendedor — sigue habiendo un solo superadmin activo. Si
  // el conteo olvidara el filtro de `rol`, contaría 2 y dejaría pasar.
  it('sigue siendo el ultimo superadmin activo aunque exista otra fila activa que es vendedor', async () => {
    filas.push(
      filaBase({ id: UUID_U2, correo: 'vendedor-activo@luxeessentialscr.com', nombre: 'Vendedor Activo', rol: 'vendedor' }),
    );
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postEstado(peticion({ id: UUID_U1, rol: 'vendedor' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(409);
    expect(filas.find((f) => f.id === UUID_U1)?.rol).toBe('superadmin');
  });
});

describe('invitar', () => {
  it('crea la fila, guarda la huella y nunca el enlace crudo', async () => {
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postInvitar(
      peticion({ correo: 'nuevo@luxe.cr', nombre: 'Nueva Persona', rol: 'vendedor' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(200);
    expect((await res.json())).toMatchObject({ ok: true, correoEnviado: true });

    const insertada = filas.find((f) => f.correo === 'nuevo@luxe.cr');
    expect(insertada).toBeTruthy();
    expect(insertada?.invitacion_hash).toMatch(/^[0-9a-f]{64}$/);

    const enlaceUsado = llamadasCorreo[0]?.enlace;
    expect(enlaceUsado).toBeTruthy();
    expect(insertada?.invitacion_hash).toBe(huellaDe(enlaceUsado));
    expect(JSON.stringify(insertada)).not.toContain(enlaceUsado);
  });

  it('normaliza el correo antes de guardarlo', async () => {
    const { cookie, csrf } = sesion('Ana Solano');
    await postInvitar(
      peticion({ correo: '  Nueva@Luxe.CR  ', nombre: 'Nueva Persona', rol: 'vendedor' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(filas.find((f) => f.correo === 'nueva@luxe.cr')).toBeTruthy();
  });

  it('avisa cuando la fila se creo pero el correo fallo (200, correoEnviado: false)', async () => {
    resendFalla = true;
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postInvitar(
      peticion({ correo: 'nuevo@luxe.cr', nombre: 'X', rol: 'vendedor' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).correoEnviado).toBe(false);
    // La fila igual quedo creada.
    expect(filas.find((f) => f.correo === 'nuevo@luxe.cr')).toBeTruthy();
  });

  it('rechaza invitar a un correo que ya esta (409)', async () => {
    filas.push(filaBase({ id: 'u-existe', correo: 'existe@luxe.cr', nombre: 'Ya Existe', rol: 'vendedor' }));
    const cantidadAntes = filas.length;
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postInvitar(
      peticion({ correo: 'existe@luxe.cr', nombre: 'X', rol: 'vendedor' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Ese correo ya está en el equipo.');
    expect(filas).toHaveLength(cantidadAntes);
    expect(llamadasCorreo).toHaveLength(0);
  });

  it('rechaza un correo con formato invalido (400)', async () => {
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postInvitar(
      peticion({ correo: 'no-es-un-correo', nombre: 'X', rol: 'vendedor' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(400);
  });

  it('rechaza un rol fuera de la lista cerrada (400)', async () => {
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postInvitar(
      peticion({ correo: 'nuevo@luxe.cr', nombre: 'X', rol: 'dueño' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(400);
  });
});

describe('reenviar', () => {
  it('genera un enlace nuevo (huella distinta) y lo manda, solo para filas sin clave_hash', async () => {
    filas.push(
      filaBase({
        id: UUID_INVITADA,
        correo: 'invitada@luxe.cr',
        nombre: 'Invitada Pendiente',
        rol: 'vendedor',
        clave_hash: null,
        clave_sal: null,
        invitacion_hash: 'huella-vieja',
        invitacion_expira: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postReenviar(peticion({ id: UUID_INVITADA }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(200);
    expect((await res.json())).toMatchObject({ ok: true, correoEnviado: true });

    const fila = filas.find((f) => f.id === UUID_INVITADA);
    expect(fila?.invitacion_hash).not.toBe('huella-vieja');
    expect(fila?.invitacion_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(llamadasCorreo[0]?.para).toBe('invitada@luxe.cr');
  });

  it('rechaza reenviar a alguien que ya entro (tiene clave_hash) con 400', async () => {
    filas.push(
      filaBase({
        id: UUID_ACTIVA,
        correo: 'activa@luxe.cr',
        nombre: 'Ya Activa',
        rol: 'vendedor',
        clave_hash: 'ya-tiene-hash',
      }),
    );
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postReenviar(peticion({ id: UUID_ACTIVA }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(400);
    expect(llamadasCorreo).toHaveLength(0);
  });

  it('reenviar a un id inexistente da 404', async () => {
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postReenviar(peticion({ id: UUID_INEXISTENTE }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(404);
  });
});

describe('estado (activar/desactivar, cambiar rol)', () => {
  it('desactiva a un vendedor sin problema (200)', async () => {
    filas.push(filaBase({ id: UUID_U2, correo: 'v@luxe.cr', nombre: 'Un Vendedor', rol: 'vendedor' }));
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postEstado(peticion({ id: UUID_U2, activo: false }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(200);
    expect(filas.find((f) => f.id === UUID_U2)?.activo).toBe(false);
  });

  it('id inexistente da 404', async () => {
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postEstado(peticion({ id: UUID_INEXISTENTE, activo: false }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(404);
  });

  it('cuerpo sin activo ni rol es 400 (no hay nada que cambiar)', async () => {
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postEstado(peticion({ id: UUID_U1 }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(400);
  });
});

describe('listar', () => {
  it('nunca devuelve clave_hash, clave_sal ni invitacion_hash', async () => {
    filas.push(
      filaBase({
        id: UUID_INVITADA,
        correo: 'invitada@luxe.cr',
        nombre: 'Invitada Pendiente',
        clave_hash: null,
        clave_sal: null,
        invitacion_hash: 'huella-secreta',
        invitacion_expira: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const { cookie } = sesion('Ana Solano');
    const res = await postListar(peticion({}, { cookie }));
    const cuerpo = await res.json();
    expect(JSON.stringify(cuerpo)).not.toContain('huella-secreta');
    for (const fila of cuerpo.equipo) {
      expect(fila).not.toHaveProperty('clave_hash');
      expect(fila).not.toHaveProperty('clave_sal');
      expect(fila).not.toHaveProperty('invitacion_hash');
    }
  });

  it('deriva el estado de cada fila: activa, invitada, vencida, desactivada', async () => {
    filas = [
      filaBase({ id: 'act', correo: 'activa@luxe.cr', nombre: 'Activa', clave_hash: 'h' }),
      filaBase({
        id: 'inv',
        correo: 'invitada@luxe.cr',
        nombre: 'Invitada',
        rol: 'vendedor',
        clave_hash: null,
        clave_sal: null,
        invitacion_expira: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      filaBase({
        id: 'venc',
        correo: 'vencida@luxe.cr',
        nombre: 'Vencida',
        rol: 'vendedor',
        clave_hash: null,
        clave_sal: null,
        invitacion_expira: new Date(Date.now() - 3_600_000).toISOString(),
      }),
      filaBase({
        id: 'baja',
        correo: 'baja@luxe.cr',
        nombre: 'De Baja',
        rol: 'vendedor',
        clave_hash: 'h',
        activo: false,
      }),
    ];
    const { cookie } = sesion('Activa');
    const res = await postListar(peticion({}, { cookie }));
    const cuerpo = await res.json();
    const estadoDe = (id: string) => cuerpo.equipo.find((f: { id: string }) => f.id === id)?.estado;
    expect(estadoDe('act')).toBe('activa');
    expect(estadoDe('inv')).toBe('invitada');
    expect(estadoDe('venc')).toBe('vencida');
    expect(estadoDe('baja')).toBe('desactivada');
  });

  // Una invitación pendiente cuya cuenta se desactivó ANTES de que la
  // persona entrara: `activo` manda primero (ver el comentario de
  // `derivarEstado` en lib/cotizador/equipo.ts). Si `estado` mirara la
  // invitación primero, el panel diría 'invitada' de alguien a quien
  // fijar-clave/route.ts ya le cierra la puerta.
  it('una invitacion pendiente y desactivada se ve como desactivada, no invitada', async () => {
    filas = [
      filaBase({ id: 'act', nombre: 'Activa' }),
      filaBase({
        id: 'inv-baja',
        correo: 'inv-baja@luxe.cr',
        nombre: 'Invitada Y Dada De Baja',
        rol: 'vendedor',
        clave_hash: null,
        clave_sal: null,
        activo: false,
        invitacion_expira: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ];
    const { cookie } = sesion('Activa');
    const res = await postListar(peticion({}, { cookie }));
    const cuerpo = await res.json();
    const fila = cuerpo.equipo.find((f: { id: string }) => f.id === 'inv-baja');
    expect(fila.estado).toBe('desactivada');
  });
});
