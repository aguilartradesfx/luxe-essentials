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
// Ronda de correcciones 1: el revisor sustituyó `autorizarSuperadmin` por
// `{ ok: true }` en `invitar`, `reenviar` y `estado` A LA VEZ y la suite
// anterior seguía en verde — el único caso sin cookie que tocaba esas
// rutas moría en el 401 de `autenticarPeticion`, antes de llegar a la
// autorización. Ahora el bloque de autorización se repite, CON el token
// anti-CSRF correcto, contra las CUATRO rutas.
//
// Se mockea `@/lib/cotizador/correo-invitacion` entero (mismo criterio que
// tests/api-cotizacion-sesion.test.ts con `@/lib/cotizador/correo`): ninguna
// prueba de este archivo llama a la API de Resend de verdad. La propia
// función `enviarInvitacion` ya tiene su cobertura de `fetchImpl` inyectado
// en tests/correo-invitacion.test.ts; acá sólo importa CUÁNDO se llama, con
// qué correo y qué pasa cuando falla.
let resendFalla = false;
// Ronda de correcciones 2, punto 3: distinto de `resendFalla`. `enviarInvitacion`
// nunca lanza EN PRODUCCIÓN (contrato documentado en
// lib/cotizador/correo-invitacion.ts), pero `invitarPersona`/`reenviarInvitacion`
// no pueden darlo por sentado para siempre — por eso llaman a través de
// `enviarInvitacionSinLanzar`, que atrapa justo esta posibilidad. Esta
// bandera simula que el contrato se rompió, para comprobar que ese `try/catch`
// hace lo que dice: nada menos, y nada más, que lo mismo que un fallo normal
// de Resend (`correoEnviado: false`, fila creada igual).
let resendLanza = false;
const llamadasCorreo: { para: string; nombre: string; enlace: string }[] = [];

vi.mock('@/lib/cotizador/correo-invitacion', () => ({
  enviarInvitacion: vi.fn(async (p: { para: string; nombre: string; enlace: string }) => {
    llamadasCorreo.push(p);
    if (resendLanza) throw new Error('fallo simulado: enviarInvitacion rompió su contrato de "nunca lanza"');
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
let erroresRpc: { message: string } | null;
let siguienteId: number;
let llamadasRpc: { nombre: string; argumentos: Record<string, unknown> }[];
let actualizacionesDirectas: number;
// Ronda de correcciones 2, punto 2: `undefined` significa "responder con la
// lógica normal del doble"; cualquier otro valor (incluido `null`) se
// devuelve tal cual como `data`, saltándose esa lógica — para simular que la
// rpc devolvió algo que no es ninguno de los tres textos reales.
let resultadoRpcForzado: unknown;
// Ronda de correcciones 1, punto 5 (CAS de `reenviar`): cuando coincide con
// el `id` de la fila que se está leyendo para reenviar, simula que OTRO
// proceso (fijar-clave, corriendo al mismo tiempo) le puso `clave_hash`
// justo después de esta lectura y antes de la escritura de más abajo — la
// misma ventana de ~100 ms de scrypt que describe fijar-clave/route.ts.
let simularClaveFijadaEntreLecturaYEscrituraId: string | null;

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
    is(columna: string, valor: unknown) {
      filtros.push([columna, valor]);
      return nodo;
    },
    order() {
      return nodo;
    },
    maybeSingle: async () => {
      if (erroresLectura) return { data: null, error: erroresLectura };
      const coincidentes = filas.filter((f) => coincide(f, filtros));
      // Mismo comportamiento que el cliente real de Supabase: con más de
      // una fila, `.maybeSingle()` no elige "la primera" en silencio —
      // devuelve el error PGRST116 ("multiple (or no) rows returned"). Sin
      // esto, dos filas con el mismo `nombre` (ver el comentario de
      // `autorizarSuperadmin` sobre por qué eso ya no debería poder pasar)
      // habrían quedado sin cobertura: el doble le devolvía a la app una
      // fila cualquiera en vez del error que la app tiene que saber manejar.
      if (coincidentes.length > 1) {
        return { data: null, error: { code: 'PGRST116', message: 'multiple (or no) rows returned' } };
      }
      const resultado = coincidentes[0] ?? null;
      if (resultado === null) return { data: null, error: null };
      // Snapshot ANTES de mutar: lo que este `await` le devuelve a quien
      // llamó es el estado tal como estaba al leer (`clave_hash: null`) —
      // exactamente lo que vería una lectura real que ganó la carrera
      // contra la escritura de `fijar-clave`. La fila REAL del arreglo
      // (no la copia) es la que se muta a continuación, para que la
      // escritura de más abajo —evaluada contra el estado ACTUAL, no
      // contra esta lectura— vea el cambio.
      const copia = { ...resultado };
      if (simularClaveFijadaEntreLecturaYEscrituraId === resultado.id) {
        resultado.clave_hash = 'clave-fijada-en-el-medio-de-la-carrera';
      }
      return { data: copia, error: null };
    },
    // Thenable: cubre `.select(...).eq(...).eq(...)` y `.select(...).order(...)`,
    // ninguno de los cuales llama a `.maybeSingle()`.
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
    // El índice único real es sobre `lower(correo)`: el doble tiene que
    // comparar igual de insensible a mayúsculas, o dejaría pasar un
    // duplicado que Postgres sí rechazaría.
    const correoNormalizado = correo.toLowerCase();
    if (filas.some((f) => f.correo.toLowerCase() === correoNormalizado)) {
      // Mismo código que devuelve Postgres al chocar contra ese índice
      // único (migración 0014).
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

// `.update(cambios).eq(...)?.is(...)?.select()` — con `.select()`, se
// resuelve al aplicarse (o no) el compare-and-swap, informando qué filas
// tocó; sin `.select()`, se resuelve directo (thenable) como un `update`
// sin condición extra que verificar.
function construirUpdate(cambios: Record<string, unknown>): any {
  actualizacionesDirectas += 1;
  const filtros: [string, unknown][] = [];
  const nodo: any = {
    eq(columna: string, valor: unknown) {
      filtros.push([columna, valor]);
      return nodo;
    },
    is(columna: string, valor: unknown) {
      filtros.push([columna, valor]);
      return nodo;
    },
    select: async () => {
      if (erroresEscritura) return { data: null, error: erroresEscritura };
      const coincidentes = filas.filter((f) => coincide(f, filtros));
      for (const f of coincidentes) Object.assign(f, cambios);
      return { data: coincidentes.map((f) => ({ id: f.id })), error: null };
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

// AVISO EXPLÍCITO, para quien lea esto dentro de un año: lo de abajo es
// una REIMPLEMENTACIÓN EN JAVASCRIPT de la lógica de
// `usuarios_panel_cambiar_estado` (supabase/migrations/0015_equipo_cambiar_estado.sql),
// no la función real. Copia su forma —incluido el `for update` sobre el
// conjunto de superadmins activos, acá simulado como un `.filter().length`
// síncrono— pero JavaScript de un solo hilo NO PUEDE reproducir la carrera
// que esa función existe para cerrar: dos llamadas a este doble nunca
// corren de verdad en paralelo, así que estas pruebas no demuestran que la
// función de Postgres sea atómica. Si algún día la migración 0015
// divergiera de esta copia —un `for update` mal puesto, un `<=` que
// debería ser `<`—, esta suite seguiría en verde sin enterarse.
//
// La decisión de no perseguir esa prueba —levantar una base desechable en
// CI— es del coordinador, tomada y aceptada (Ronda de correcciones 1,
// hallazgo "R1"). La verificación de que la guarda real, contra Postgres,
// rechaza la carrera de dos superadmins concurrentes es un PASO MANUAL,
// documentado como tal en el README (Tarea 8) — mismo criterio que ya
// existe para `usuarios_panel_intento_fallido` (ver el comentario de
// tests/usuarios-autenticacion.test.ts).
//
// Lo que SÍ queda anclado sobre el código de PRODUCCIÓN, y por eso vale la
// pena que este doble exista: el CONTRATO — que `cambiarEstado` llama a
// esta función por `rpc` con los argumentos correctos, y que ya no hace
// ningún `select`+`update` de dos pasos por su cuenta (ver la prueba
// 'cambiarEstado llama a la rpc con los argumentos correctos y no hace
// ninguna escritura directa').
async function ejecutarRpc(nombre: string, argumentos: Record<string, unknown>) {
  llamadasRpc.push({ nombre, argumentos });
  if (erroresRpc) return { data: null, error: erroresRpc };
  // Ronda de correcciones 2, punto 2: deja simular que la rpc devuelve un
  // `data` que no es ninguno de los tres textos reales — el caso que
  // `cambiarEstado` tiene que tratar como error, no como éxito silencioso.
  if (resultadoRpcForzado !== undefined) return { data: resultadoRpcForzado, error: null };
  if (nombre !== 'usuarios_panel_cambiar_estado') {
    return { data: null, error: { message: `rpc no soportada en el doble: ${nombre}` } };
  }

  const p_id = argumentos.p_id as string;
  const p_activo = argumentos.p_activo as boolean | null;
  const p_rol = argumentos.p_rol as Fila['rol'] | null;

  const fila = filas.find((f) => f.id === p_id);
  if (!fila) return { data: 'no_encontrado', error: null };

  const nuevoRol = p_rol ?? fila.rol;
  const nuevoActivo = p_activo ?? fila.activo;
  const eraSuperadminActivo = fila.rol === 'superadmin' && fila.activo;
  const seguiraSuperadminActivo = nuevoRol === 'superadmin' && nuevoActivo;

  if (eraSuperadminActivo && !seguiraSuperadminActivo) {
    const activos = filas.filter((f) => f.rol === 'superadmin' && f.activo).length;
    if (activos <= 1) return { data: 'ultimo_superadmin', error: null };
  }

  fila.rol = nuevoRol;
  fila.activo = nuevoActivo;
  return { data: 'ok', error: null };
}

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => construirSelect(),
      insert: (cambios: Record<string, unknown>) => construirInsert(cambios),
      update: (cambios: Record<string, unknown>) => construirUpdate(cambios),
    }),
    rpc: (nombre: string, argumentos: Record<string, unknown>) => ejecutarRpc(nombre, argumentos),
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

// Ronda de correcciones 2 (Tarea 5, invitaciones y roles): `autorizarSuperadmin`
// relee por ID, no por nombre (ver lib/cotizador/equipo.ts) — así que el id
// de cada fila es ahora el dato que de verdad importa para las pruebas de
// autorización. `UUID_U1` es el id por defecto de `filaBase()`, más abajo:
// las dos únicas cosas que tienen que coincidir SIEMPRE son "el id que lleva
// la cookie" y "el id de la fila que `autorizarSuperadmin` va a releer".
const UUID_U1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const UUID_U2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const UUID_INVITADA = 'bbbbbbbb-0000-4000-8000-000000000001';
const UUID_ACTIVA = 'cccccccc-0000-4000-8000-000000000001';
const UUID_INEXISTENTE = 'dddddddd-0000-4000-8000-000000000001';
const UUID_BETO_VENDEDOR = 'eeeeeeee-0000-4000-8000-000000000001';
const UUID_CARLA_BAJA = 'eeeeeeee-0000-4000-8000-000000000002';
const UUID_DARIO_REAL = 'eeeeeeee-0000-4000-8000-000000000003';
// Con forma válida de UUID (pasa `esIdValido` en lib/sesion.ts, así que
// `emitirSesion` no lo rechaza), pero que a propósito no corresponde a
// ninguna fila de `filas`.
const UUID_SIN_FILA = 'ffffffff-0000-4000-8000-000000000001';

// Cookie firmada de verdad, con el csrf que le corresponde. `rol` es el que
// declara la COOKIE — no tiene por qué coincidir con lo que diga la base —
// e `id` es el de la fila que `autorizarSuperadmin` va a releer: por
// defecto, `UUID_U1`, el id de la superadmin principal que arma
// `filaBase()`. Eso es justo lo que las pruebas de la promesa central
// necesitan poder separar: una cookie VÁLIDA y FIRMADA que apunta —por
// nombre, por rol, o por id— a una fila cuyo estado real es otro.
function sesion(nombre: string, rol: 'vendedor' | 'superadmin' = 'superadmin', id: string = UUID_U1) {
  const { cookie, csrf } = emitirSesion(nombre, rol, id);
  return { cookie: cookie.split(';')[0], csrf };
}

function filaBase(extra: Partial<Fila> = {}): Fila {
  return {
    id: UUID_U1,
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

beforeEach(() => {
  process.env.LUXE_SESION_SECRETO = 'secreto-de-firma-de-prueba';
  filas = [filaBase({ id: UUID_U1 })];
  erroresLectura = null;
  erroresInsert = null;
  erroresEscritura = null;
  erroresRpc = null;
  siguienteId = 0;
  resendFalla = false;
  resendLanza = false;
  llamadasCorreo.length = 0;
  llamadasRpc = [];
  actualizacionesDirectas = 0;
  simularClaveFijadaEntreLecturaYEscrituraId = null;
  resultadoRpcForzado = undefined;
});

describe('autorizacion: el rol de la cookie no autoriza nada (las cuatro rutas)', () => {
  it('un superadmin activo, de verdad en la base, entra a listar (200) — control de que el guardia no rechaza a todos', async () => {
    const { cookie } = sesion('Ana Solano');
    const res = await postListar(peticion({}, { cookie }));
    expect(res.status).toBe(200);
  });

  // La promesa central de la fase: la cookie firmada dice 'superadmin' —es
  // una cookie VÁLIDA, no forjada— pero la fila de esa persona en la base
  // dice 'vendedor'. Tiene que rechazarse igual, en las CUATRO rutas.
  it('listar: rechaza a un vendedor aunque su cookie firmada diga superadmin', async () => {
    filas.push(filaBase({ id: UUID_BETO_VENDEDOR, nombre: 'Beto Vendedor', correo: 'beto@luxeessentialscr.com', rol: 'vendedor' }));
    const { cookie } = sesion('Beto Vendedor', 'superadmin', UUID_BETO_VENDEDOR);
    const res = await postListar(peticion({}, { cookie }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('No tenés permiso para administrar el equipo.');
  });

  it('invitar: rechaza a un vendedor aunque su cookie firmada diga superadmin (con CSRF válido)', async () => {
    filas.push(filaBase({ id: UUID_BETO_VENDEDOR, nombre: 'Beto Vendedor', correo: 'beto@luxeessentialscr.com', rol: 'vendedor' }));
    const { cookie, csrf } = sesion('Beto Vendedor', 'superadmin', UUID_BETO_VENDEDOR);
    const res = await postInvitar(
      peticion({ correo: 'nuevo@luxe.cr', nombre: 'Nueva Persona', rol: 'vendedor' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('No tenés permiso para administrar el equipo.');
    expect(filas.find((f) => f.correo === 'nuevo@luxe.cr')).toBeUndefined();
    expect(llamadasCorreo).toHaveLength(0);
  });

  it('reenviar: rechaza a un vendedor aunque su cookie firmada diga superadmin (con CSRF válido)', async () => {
    filas.push(filaBase({ id: UUID_BETO_VENDEDOR, nombre: 'Beto Vendedor', correo: 'beto@luxeessentialscr.com', rol: 'vendedor' }));
    filas.push(
      filaBase({
        id: UUID_INVITADA,
        correo: 'invitada@luxe.cr',
        nombre: 'Invitada',
        rol: 'vendedor',
        clave_hash: null,
        clave_sal: null,
        invitacion_expira: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const { cookie, csrf } = sesion('Beto Vendedor', 'superadmin', UUID_BETO_VENDEDOR);
    const res = await postReenviar(peticion({ id: UUID_INVITADA }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('No tenés permiso para administrar el equipo.');
    expect(llamadasCorreo).toHaveLength(0);
  });

  it('estado: rechaza a un vendedor aunque su cookie firmada diga superadmin (con CSRF válido)', async () => {
    filas.push(filaBase({ id: UUID_BETO_VENDEDOR, nombre: 'Beto Vendedor', correo: 'beto@luxeessentialscr.com', rol: 'vendedor' }));
    const { cookie, csrf } = sesion('Beto Vendedor', 'superadmin', UUID_BETO_VENDEDOR);
    const res = await postEstado(peticion({ id: UUID_U1, activo: false }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('No tenés permiso para administrar el equipo.');
    // Y la fila objetivo no se tocó.
    expect(filas.find((f) => f.id === UUID_U1)?.activo).toBe(true);
    expect(llamadasRpc).toHaveLength(0);
  });

  // Cookie válida con rol 'superadmin' Y la base también dice 'superadmin'
  // para ese nombre — pero `activo: false`. Sólo la desactivación distingue
  // este caso del de control de arriba. Repetido en las cuatro rutas.
  it('listar: rechaza a un superadmin desactivado en la base', async () => {
    filas = [filaBase({ id: UUID_CARLA_BAJA, nombre: 'Carla Baja', correo: 'carla@luxeessentialscr.com', activo: false })];
    const { cookie } = sesion('Carla Baja', 'superadmin', UUID_CARLA_BAJA);
    const res = await postListar(peticion({}, { cookie }));
    expect(res.status).toBe(403);
  });

  it('invitar: rechaza a un superadmin desactivado en la base (con CSRF válido)', async () => {
    filas = [filaBase({ id: UUID_CARLA_BAJA, nombre: 'Carla Baja', correo: 'carla@luxeessentialscr.com', activo: false })];
    const { cookie, csrf } = sesion('Carla Baja', 'superadmin', UUID_CARLA_BAJA);
    const res = await postInvitar(
      peticion({ correo: 'nuevo@luxe.cr', nombre: 'Nueva Persona', rol: 'vendedor' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(403);
    expect(filas.find((f) => f.correo === 'nuevo@luxe.cr')).toBeUndefined();
    expect(llamadasCorreo).toHaveLength(0);
  });

  it('reenviar: rechaza a un superadmin desactivado en la base (con CSRF válido)', async () => {
    filas = [
      filaBase({ id: UUID_CARLA_BAJA, nombre: 'Carla Baja', correo: 'carla@luxeessentialscr.com', activo: false }),
      filaBase({
        id: UUID_INVITADA,
        correo: 'invitada@luxe.cr',
        nombre: 'Invitada',
        rol: 'vendedor',
        clave_hash: null,
        clave_sal: null,
        invitacion_expira: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ];
    const { cookie, csrf } = sesion('Carla Baja', 'superadmin', UUID_CARLA_BAJA);
    const res = await postReenviar(peticion({ id: UUID_INVITADA }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(403);
    expect(llamadasCorreo).toHaveLength(0);
  });

  it('estado: rechaza a un superadmin desactivado en la base (con CSRF válido)', async () => {
    filas = [
      filaBase({ id: UUID_U1 }),
      filaBase({ id: UUID_CARLA_BAJA, nombre: 'Carla Baja', correo: 'carla@luxeessentialscr.com', activo: false }),
    ];
    const { cookie, csrf } = sesion('Carla Baja', 'superadmin', UUID_CARLA_BAJA);
    const res = await postEstado(peticion({ id: UUID_U1, activo: false }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(403);
    expect(filas.find((f) => f.id === UUID_U1)?.activo).toBe(true);
    expect(llamadasRpc).toHaveLength(0);
  });

  it('un vendedor real (cookie y base de acuerdo) también recibe 403', async () => {
    filas.push(filaBase({ id: UUID_DARIO_REAL, nombre: 'Dario Real', correo: 'dario@luxeessentialscr.com', rol: 'vendedor' }));
    const { cookie } = sesion('Dario Real', 'vendedor', UUID_DARIO_REAL);
    const res = await postListar(peticion({}, { cookie }));
    expect(res.status).toBe(403);
  });

  // Ronda de correcciones 2: la prueba decisiva de que `autorizarSuperadmin`
  // relee por ID y no por nombre. En TODAS las demás pruebas de este
  // describe, el nombre de la cookie coincide con el nombre de la fila que
  // el id también identifica — así que una regresión a la búsqueda por
  // nombre de antes de esta ronda las pasaría igual, por el motivo
  // equivocado. Acá el nombre de la cookie ('Ana Solano') es el de una
  // superadmin ACTIVA de verdad, pero el id apunta a OTRA fila —un
  // vendedor—. Si `autorizarSuperadmin` buscara por nombre, encontraría a
  // Ana y autorizaría (200); buscando por id, como debe, encuentra al
  // vendedor y rechaza (403).
  it('el nombre de la cookie no importa: autoriza (o no) según la fila que señala el ID, no el nombre', async () => {
    filas.push(
      filaBase({ id: UUID_DARIO_REAL, nombre: 'Dario Real', correo: 'dario@luxeessentialscr.com', rol: 'vendedor' }),
    );
    // El nombre de la cookie es 'Ana Solano' —superadmin activa real—, pero
    // el id que lleva es el de Darío, que es vendedor.
    const { cookie } = sesion('Ana Solano', 'superadmin', UUID_DARIO_REAL);
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

describe('el ultimo superadmin activo no se puede tocar (via rpc atomica)', () => {
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
  // guarda tiene que rechazar igual.
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
  // `rol: 'superadmin'` de verdad, no sólo por `activo: true`.
  it('sigue siendo el ultimo superadmin activo aunque exista otra fila activa que es vendedor', async () => {
    filas.push(
      filaBase({ id: UUID_U2, correo: 'vendedor-activo@luxeessentialscr.com', nombre: 'Vendedor Activo', rol: 'vendedor' }),
    );
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postEstado(peticion({ id: UUID_U1, rol: 'vendedor' }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(409);
    expect(filas.find((f) => f.id === UUID_U1)?.rol).toBe('superadmin');
  });

  // El contrato con la base: `cambiarEstado` llama a la rpc con los
  // argumentos correctos, y NO hace ningún `select`/`update` de dos pasos
  // por su cuenta — la atomicidad real vive en supabase/migrations/0015,
  // no en este archivo (que no puede probarla: JS de un solo hilo no puede
  // reproducir la carrera de verdad).
  it('cambiarEstado llama a la rpc con los argumentos correctos y no hace ninguna escritura directa', async () => {
    filas.push(filaBase({ id: UUID_U2, correo: 'vendedor@luxeessentialscr.com', nombre: 'Vendedor', rol: 'vendedor' }));
    const { cookie, csrf } = sesion('Ana Solano');
    await postEstado(peticion({ id: UUID_U2, activo: false }, { cookie, 'x-csrf-token': csrf }));
    expect(llamadasRpc).toContainEqual({
      nombre: 'usuarios_panel_cambiar_estado',
      argumentos: { p_id: UUID_U2, p_activo: false, p_rol: null },
    });
    expect(actualizacionesDirectas).toBe(0);
  });

  it('un fallo de la rpc es 500, no 409 ni 200', async () => {
    erroresRpc = { message: 'la base no responde' };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postEstado(peticion({ id: UUID_U1, activo: false }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(500);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // Ronda de correcciones 2, punto 2: el `else` de `cambiarEstado` era
  // fail-open — cualquier `data` que no fuera ninguno de los dos motivos de
  // rechazo, incluido `null`, caía en `return { ok: true }` y la ruta
  // respondía 200 sin que se hubiera escrito nada. Hoy es inalcanzable con
  // la función real (sólo devuelve 'ok' | 'no_encontrado' | 'ultimo_superadmin'),
  // pero esta prueba fuerza justo ese valor inesperado a través del doble
  // (`resultadoRpcForzado`) para anclar que la rama por defecto es un
  // error registrado, no un éxito silencioso.
  it('un valor inesperado de la rpc (ni ok, ni un motivo de rechazo conocido) es error, no un 200 fantasma', async () => {
    resultadoRpcForzado = 'algo-que-la-funcion-real-nunca-devolveria';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postEstado(peticion({ id: UUID_U1, activo: false }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(500);
    expect(consoleError).toHaveBeenCalled();
    // Y no se coló ningún éxito fantasma: la fila sigue como estaba.
    expect(filas.find((f) => f.id === UUID_U1)?.activo).toBe(true);
    consoleError.mockRestore();
  });

  // Mismo argumento con `data: null` en particular: es el valor más fácil
  // de producir por accidente (una rpc que no existe, un `select` sin
  // `returning`), y el que un `else` fail-open dejaría pasar más seguido.
  it('data: null de la rpc tambien es error, no un 200 fantasma', async () => {
    resultadoRpcForzado = null;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postEstado(peticion({ id: UUID_U1, activo: false }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(500);
    consoleError.mockRestore();
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

  // Ronda de correcciones 2, punto 3: el revisor quitó el `try/catch` de
  // `enviarInvitacionSinLanzar` y la suite anterior (48/48) seguía en
  // verde — el mock nunca lanzaba, así que nada lo ejercitaba. Esta prueba
  // hace que el mock SÍ lance, y afirma el comportamiento exacto que ese
  // `try/catch` existe para garantizar: el mismo 200 con
  // `correoEnviado: false` que un fallo NORMAL de Resend, no un 500 que
  // esconda que la fila ya se creó.
  it('si enviarInvitacion LANZA (no sólo falla), invitar igual responde 200 con correoEnviado:false y la fila creada', async () => {
    resendLanza = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postInvitar(
      peticion({ correo: 'nuevo@luxe.cr', nombre: 'X', rol: 'vendedor' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).correoEnviado).toBe(false);
    expect(filas.find((f) => f.correo === 'nuevo@luxe.cr')).toBeTruthy();
    consoleError.mockRestore();
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

  // El índice único real es sobre `lower(correo)`: mayúsculas distintas
  // tienen que seguir chocando.
  it('rechaza un correo que ya esta, aunque las mayusculas sean distintas', async () => {
    filas.push(filaBase({ id: 'u-existe', correo: 'existe@luxe.cr', nombre: 'Ya Existe', rol: 'vendedor' }));
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postInvitar(
      peticion({ correo: 'EXISTE@Luxe.cr', nombre: 'X', rol: 'vendedor' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(409);
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

  // Ronda de correcciones 1, Importante 2: no hay índice único sobre
  // `nombre`, y `autorizarSuperadmin` relee POR NOMBRE. Sin este rechazo,
  // invitar a alguien con el mismo nombre que un superadmin existente lo
  // deja sin forma de autorizar nada — ni siquiera para deshacerlo.
  it('rechaza invitar con un nombre que ya existe (409)', async () => {
    const cantidadAntes = filas.length;
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postInvitar(
      peticion({ correo: 'otra-ana@luxe.cr', nombre: 'Ana Solano', rol: 'vendedor' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(409);
    expect(filas).toHaveLength(cantidadAntes);
    expect(llamadasCorreo).toHaveLength(0);
  });

  it('el rechazo por nombre repetido es insensible a mayusculas y a espacios de sobra', async () => {
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postInvitar(
      peticion({ correo: 'otra-ana@luxe.cr', nombre: '  ana   SOLANO  ', rol: 'vendedor' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(409);
  });

  // Control: nombres genuinamente distintos no chocan entre sí.
  it('nombres distintos no disparan el rechazo (200)', async () => {
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postInvitar(
      peticion({ correo: 'otra-persona@luxe.cr', nombre: 'Otra Persona Distinta', rol: 'vendedor' }, { cookie, 'x-csrf-token': csrf }),
    );
    expect(res.status).toBe(200);
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

  // Ronda de correcciones 1, punto 6: mismo contrato que `invitar` — si el
  // correo falla, la respuesta tiene que decirlo. Acá es peor que en
  // `invitar`: la invitación VIEJA ya quedó invalidada (la huella nueva ya
  // se escribió) antes de intentar mandar el correo nuevo.
  it('avisa cuando la invitacion se reenvio pero el correo fallo (200, correoEnviado: false)', async () => {
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
    resendFalla = true;
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postReenviar(peticion({ id: UUID_INVITADA }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(200);
    expect((await res.json()).correoEnviado).toBe(false);
    // Y la huella sí cambió (la invitación vieja quedó invalidada de todas
    // formas): no se revierte el `update` porque el correo haya fallado.
    expect(filas.find((f) => f.id === UUID_INVITADA)?.invitacion_hash).not.toBe('huella-vieja');
  });

  // Mismo caso que la prueba equivalente de `invitar`: `enviarInvitacionSinLanzar`
  // protege a los dos escritores, no sólo a uno.
  it('si enviarInvitacion LANZA al reenviar, la ruta igual responde 200 con correoEnviado:false', async () => {
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
    resendLanza = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postReenviar(peticion({ id: UUID_INVITADA }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(200);
    expect((await res.json()).correoEnviado).toBe(false);
    consoleError.mockRestore();
  });

  // Ronda de correcciones 1, punto 5 (compare-and-swap). Entre la lectura y
  // la escritura de `reenviarInvitacion`, la persona invitada corre
  // `fijar-clave` (simulado acá). Sin el `.is('clave_hash', null)` en el
  // `update`, esta escritura pisaría la invitación nueva encima de una
  // clave que la persona recién eligió.
  it('no reenvia si la persona fijo su clave justo entre la lectura y la escritura (carrera)', async () => {
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
    simularClaveFijadaEntreLecturaYEscrituraId = UUID_INVITADA;
    const { cookie, csrf } = sesion('Ana Solano');
    const res = await postReenviar(peticion({ id: UUID_INVITADA }, { cookie, 'x-csrf-token': csrf }));
    expect(res.status).toBe(400);
    expect(llamadasCorreo).toHaveLength(0);
    // La clave que la persona fijó "en el medio" sigue intacta.
    expect(filas.find((f) => f.id === UUID_INVITADA)?.clave_hash).toBe('clave-fijada-en-el-medio-de-la-carrera');
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
      filaBase({ id: UUID_U1, correo: 'activa@luxe.cr', nombre: 'Activa', clave_hash: 'h' }),
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
    expect(estadoDe(UUID_U1)).toBe('activa');
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
      filaBase({ id: UUID_U1, nombre: 'Activa' }),
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

describe('autorizarSuperadmin: diagnostico de un fallo de lectura vs. sin fila', () => {
  // Ronda de correcciones 1, Importante 4: antes `if (error || !data)` se
  // tragaba las dos causas en el mismo `{ ok: false }` mudo. Ahora cada una
  // deja su propia línea en el log — comprobamos que hay una, sin atarnos
  // al texto exacto (eso es un detalle de redacción, no el contrato).
  it('una base caída al autorizar deja una linea en el log, no silencio', async () => {
    erroresLectura = { message: 'conexión caída' };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { cookie } = sesion('Ana Solano');
    const res = await postListar(peticion({}, { cookie }));
    expect(res.status).toBe(403);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // Ronda de correcciones 2: antes esto probaba "un nombre sin fila" —
  // `autorizarSuperadmin` releía por nombre. Ahora relee por id (ver su
  // comentario en lib/cotizador/equipo.ts), así que el escenario
  // equivalente es una cookie con un id bien formado —pasa `esIdValido`,
  // `emitirSesion` no la rechaza al emitirla— que no corresponde a
  // ninguna fila: una cuenta borrada después de que la cookie ya existía,
  // por ejemplo.
  it('una cookie con un id sin fila en el equipo deja una linea en el log', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { cookie } = sesion('Cualquiera', 'superadmin', UUID_SIN_FILA);
    const res = await postListar(peticion({}, { cookie }));
    expect(res.status).toBe(403);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // Ronda de correcciones 2: la prueba que vivía acá ("dos filas con el
  // mismo nombre no hacen que la ruta explote") quedó retirada — probaba
  // el error PGRST116 de `.maybeSingle()` sobre una búsqueda POR NOMBRE,
  // que ya no existe en `autorizarSuperadmin` (ahora busca por id, la
  // clave primaria de la tabla: dos filas jamás pueden compartirlo). La
  // guarda contra nombres repetidos sigue viva en `invitarPersona` —ver
  // el describe 'invitar', más abajo—, pero ya no por este motivo.
});
