import 'server-only';
import { normalizarCorreo, type Rol } from '@/lib/cotizador/usuarios';
import { generarInvitacion } from '@/lib/cotizador/invitaciones';
import { enviarInvitacion } from '@/lib/cotizador/correo-invitacion';
import type { DepsCorreo, ResultadoCorreo } from '@/lib/cotizador/correo';

// Ronda de correcciones 1: se agrega `rpc` — `cambiarEstado` (más abajo) ya
// no cuenta y escribe en dos pasos desde JavaScript; delega los dos en una
// sola sentencia dentro de la base (ver supabase/migrations/0015_equipo_cambiar_estado.sql).
export type Db = {
  from: (tabla: string) => any;
  rpc: (nombre: string, argumentos: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>;
};

const TABLA = 'usuarios_panel';
const RPC_CAMBIAR_ESTADO = 'usuarios_panel_cambiar_estado';

// Mismo texto en las cuatro rutas de app/api/equipo/*: quien no es
// superadmin (de verdad, releído de la base — ver `autorizarSuperadmin`)
// recibe siempre este mensaje, nunca uno distinto según la ruta. Se exporta
// desde acá para que las cuatro lo importen en vez de copiarlo.
export const SIN_PERMISO = 'No tenés permiso para administrar el equipo.';

export type Estado = 'invitada' | 'vencida' | 'activa' | 'desactivada';

export type FilaEquipo = {
  id: string;
  correo: string;
  nombre: string;
  rol: Rol;
  activo: boolean;
  estado: Estado;
  ultimo_acceso: string | null;
};

// La pieza central de esta fase. `auth.rol` (de `autenticarPeticion`) sale
// de la cookie, y una cookie vive hasta 30 días sin que nada la obligue a
// refrescarse — así lo advierte el comentario de
// `lib/autenticacion-cotizador.ts`. Si esta función confiara en ese rol, a
// un superadmin al que se le baja el rol o se le desactiva la cuenta le
// quedaría, durante hasta un mes, el poder de invitar y desactivar gente:
// exactamente el poder que la desactivación pretendía cortar. Por eso relee
// la fila de la base en cada llamada y decide sobre el dato de AHORA, nunca
// sobre el que traía la cookie cuando se firmó.
//
// Ronda de correcciones 2: releía por NOMBRE, no por id. Era el mismo
// criterio de identidad que usaba el resto del panel en ese momento —la
// cookie sólo llevaba el nombre—, pero un nombre no es único, y esa
// elección se pagó dos veces: primero como un bloqueo irreversible
// (invitar a alguien con el mismo nombre que un superadmin lo dejaba sin
// forma de autorizar nada, ni para deshacerlo), y después como una
// ventana de carrera en el chequeo agregado para evitarlo (dos
// inserciones concurrentes con el mismo nombre podían pasar las dos el
// chequeo antes de que cualquiera escribiera). El id es la clave primaria
// de `usuarios_panel` — único por definición de la base, no por
// disciplina de la aplicación — así que ahora la cookie lo lleva (ver
// `lib/sesion.ts`) y esta función relee por ahí: cierra el problema de
// raíz en vez de agregarle otro chequeo al costado.
//
// `invitarPersona` (más abajo) sigue rechazando un nombre repetido, pero
// ya no por esto: dos personas con el mismo nombre en el listado del
// equipo son confusas, no un agujero de seguridad.
//
// Ronda de correcciones 1: antes `if (error || !data)` se tragaba las dos
// causas en el mismo `{ ok: false }` silencioso — una base caída le
// aparecía a la única superadmin del equipo como "no tenés permiso", sin
// una sola línea en el log para distinguir "no pude leer" de "no hay
// ninguna fila con ese id". Fallar cerrado en los dos casos sigue siendo
// lo correcto; fallar cerrado y mudo, no.
export async function autorizarSuperadmin(
  id: string,
  db: Db,
): Promise<{ ok: true; id: string } | { ok: false }> {
  const { data, error } = await db
    .from(TABLA)
    .select('id, rol, activo')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error(
      '[cotizador] No se pudo releer la fila del equipo para autorizar.',
      id,
      error.message,
    );
    return { ok: false };
  }
  if (!data) {
    console.error(
      '[cotizador] La cookie trae un id sin fila en el equipo al autorizar.',
      id,
    );
    return { ok: false };
  }

  const fila = data as { id: string; rol: Rol; activo: boolean };
  if (fila.rol !== 'superadmin' || !fila.activo) return { ok: false };
  return { ok: true, id: fila.id };
}

// El orden de estas comprobaciones no es arbitrario: `activo` manda
// primero. Desactivar a alguien invitado —que todavía no fijó su
// clave— igual le corta el paso: `app/api/cotizacion/fijar-clave/route.ts`
// rechaza el enlace de cualquier fila con `activo: false`, tenga o no
// `clave_hash`. Si `estado` mirara primero la invitación, el panel
// seguiría diciendo 'invitada' de alguien a quien ya se le cerró la puerta,
// y quien administra el equipo creería que ese enlace todavía sirve.
function derivarEstado(
  fila: { clave_hash: string | null; activo: boolean; invitacion_expira: string | null },
  ahora: Date,
): Estado {
  if (!fila.activo) return 'desactivada';
  if (fila.clave_hash === null) {
    const vigente =
      fila.invitacion_expira !== null && new Date(fila.invitacion_expira).getTime() > ahora.getTime();
    return vigente ? 'invitada' : 'vencida';
  }
  return 'activa';
}

export async function listarEquipo(db: Db, ahora: Date = new Date()): Promise<FilaEquipo[]> {
  // `clave_hash` se pide sólo para derivar `estado` más abajo, y se
  // descarta antes de devolver la fila. `clave_sal` e `invitacion_hash` ni
  // siquiera se seleccionan: no hay ningún motivo para que salgan de la
  // base hacia esta pantalla.
  const { data, error } = await db
    .from(TABLA)
    .select('id, correo, nombre, rol, activo, clave_hash, invitacion_expira, ultimo_acceso')
    .order('creado_at', { ascending: true });

  if (error) {
    throw new Error(`[cotizador] No se pudo listar el equipo: ${error.message}`);
  }

  const filas = (data ?? []) as Array<{
    id: string;
    correo: string;
    nombre: string;
    rol: Rol;
    activo: boolean;
    clave_hash: string | null;
    invitacion_expira: string | null;
    ultimo_acceso: string | null;
  }>;

  return filas.map((fila) => ({
    id: fila.id,
    correo: fila.correo,
    nombre: fila.nombre,
    rol: fila.rol,
    activo: fila.activo,
    estado: derivarEstado(fila, ahora),
    ultimo_acceso: fila.ultimo_acceso,
  }));
}

// Insensible a mayúsculas y a espacios de sobra: dos formas distintas de
// escribir el mismo nombre ("Ana   Solano" / "ana solano") no deben poder
// colisionar por accidente en `autorizarSuperadmin`, y tampoco deben poder
// esquivar el rechazo de más abajo por eso. Sólo se usa para COMPARAR — lo
// que se guarda en la fila es el nombre tal como se escribió.
function normalizarNombre(nombre: string): string {
  return nombre.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Nunca lanza, aunque `enviarInvitacion` lo haga: ese invariante ("nunca
// lanza") vive en OTRO módulo (lib/cotizador/correo-invitacion.ts), y esta
// función no puede darlo por sentado para siempre. Si algún día deja de
// cumplirse, la fila que `invitarPersona`/`reenviarInvitacion` ya crearon o
// actualizaron no puede perderse detrás de una excepción sin capturar —eso
// dejaría a la ruta devolviendo un 500 genérico sin `correoEnviado: false`,
// y a quien invitó reintentando contra un correo que el 23505 ya rechaza.
async function enviarInvitacionSinLanzar(
  params: { para: string; nombre: string; enlace: string },
  deps: DepsCorreo,
): Promise<ResultadoCorreo> {
  try {
    return await enviarInvitacion(params, deps);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type ResultadoInvitar =
  | { ok: true; correoEnviado: boolean }
  | { ok: false; motivo: 'duplicado' }
  | { ok: false; motivo: 'nombre_duplicado' }
  | { ok: false; motivo: 'error'; error: string };

export async function invitarPersona(
  db: Db,
  deps: DepsCorreo,
  datos: { correo: string; nombre: string; rol: Rol },
): Promise<ResultadoInvitar> {
  const correo = normalizarCorreo(datos.correo);

  // Ronda de correcciones 2: ya no hace falta por seguridad —
  // `autorizarSuperadmin` relee por id, no por nombre (ver su comentario,
  // arriba)—, pero se conserva: dos personas con el mismo nombre en el
  // listado del equipo son confusas para quien administra, y no hay
  // ningún motivo para permitirlo.
  const nombreNormalizado = normalizarNombre(datos.nombre);
  const { data: existentes, error: errorNombres } = await db.from(TABLA).select('nombre');
  if (errorNombres) {
    return { ok: false, motivo: 'error', error: errorNombres.message };
  }
  const nombreRepetido = ((existentes ?? []) as Array<{ nombre: string }>).some(
    (fila) => normalizarNombre(fila.nombre) === nombreNormalizado,
  );
  if (nombreRepetido) return { ok: false, motivo: 'nombre_duplicado' };

  const { enlace, huella, expira } = generarInvitacion();

  const { error } = await db.from(TABLA).insert({
    correo,
    nombre: datos.nombre,
    rol: datos.rol,
    activo: true,
    invitacion_hash: huella,
    invitacion_expira: expira.toISOString(),
  });

  if (error) {
    // 23505: violación del índice único sobre `lower(correo)` — ese correo
    // ya tiene una fila. Cualquier otro código es un fallo real de la base.
    if (error.code === '23505') return { ok: false, motivo: 'duplicado' };
    return { ok: false, motivo: 'error', error: error.message };
  }

  // La fila ya quedó creada arriba: si el correo de invitación falla acá
  // abajo, NO se deshace el insert ni se relanza. Quien invitó tiene que
  // enterarse de que el correo no salió (ver `correoEnviado` en la
  // respuesta de la ruta) — pero la fila existe igual, y `reenviarInvitacion`
  // es el camino para intentarlo de nuevo.
  const resultadoCorreo = await enviarInvitacionSinLanzar({ para: correo, nombre: datos.nombre, enlace }, deps);
  if (!resultadoCorreo.ok) {
    console.error(
      '[cotizador] La fila del equipo se creó pero el correo de invitación no salió.',
      correo,
      resultadoCorreo.error,
    );
  }

  return { ok: true, correoEnviado: resultadoCorreo.ok };
}

export type ResultadoReenviar =
  | { ok: true; correoEnviado: boolean }
  | { ok: false; motivo: 'no_encontrado' }
  | { ok: false; motivo: 'ya_activo' }
  | { ok: false; motivo: 'error'; error: string };

export async function reenviarInvitacion(db: Db, deps: DepsCorreo, id: string): Promise<ResultadoReenviar> {
  const { data, error: errorLectura } = await db
    .from(TABLA)
    .select('id, correo, nombre, clave_hash')
    .eq('id', id)
    .maybeSingle();

  if (errorLectura) return { ok: false, motivo: 'error', error: errorLectura.message };
  if (!data) return { ok: false, motivo: 'no_encontrado' };

  const fila = data as { id: string; correo: string; nombre: string; clave_hash: string | null };

  // Sólo sobre filas SIN `clave_hash`: reenviar a alguien que ya entró no
  // tiene sentido y le borraría el acceso (el enlace nuevo, al fijarse,
  // reemplazaría la clave que esa persona ya eligió).
  if (fila.clave_hash !== null) return { ok: false, motivo: 'ya_activo' };

  const { enlace, huella, expira } = generarInvitacion();

  // Ronda de correcciones 1: entre la lectura de arriba y esta escritura,
  // la persona invitada puede estar corriendo `fijar-clave` en este mismo
  // instante — esa ruta tarda ~100 ms en derivar el hash de la clave nueva
  // (scrypt, a propósito lento), que es tiempo de sobra para que esta
  // petición se cuele en el medio. Sin el `.is('clave_hash', null)` de
  // abajo, esta escritura pisaría la invitación con una nueva IGUAL de
  // rápido, y la persona terminaría con la clave que acaba de elegir
  // inutilizada por un enlace que ni pidió. Mismo patrón de
  // compare-and-swap que `fijar-clave/route.ts`: el filtro se vuelve a
  // evaluar contra el estado ACTUAL de la fila, no contra la lectura de
  // arriba, y `.select('id')` deja ver si de verdad tocó algo.
  const { data: filasAfectadas, error: errorEscritura } = await db
    .from(TABLA)
    .update({ invitacion_hash: huella, invitacion_expira: expira.toISOString() })
    .eq('id', id)
    .is('clave_hash', null)
    .select('id');

  if (errorEscritura) return { ok: false, motivo: 'error', error: errorEscritura.message };
  if (!filasAfectadas || (filasAfectadas as unknown[]).length === 0) {
    // La fila ya no está como se leyó: alguien fijó su clave en el medio.
    // Mismo motivo de rechazo que arriba, aunque la causa sea otra —no hay
    // nada más que decir que "ya no corresponde reenviar".
    return { ok: false, motivo: 'ya_activo' };
  }

  const resultadoCorreo = await enviarInvitacionSinLanzar({ para: fila.correo, nombre: fila.nombre, enlace }, deps);
  if (!resultadoCorreo.ok) {
    console.error(
      '[cotizador] Se reenvió la invitación pero el correo no salió.',
      fila.correo,
      resultadoCorreo.error,
    );
  }

  return { ok: true, correoEnviado: resultadoCorreo.ok };
}

export type CambiosEstado = { activo?: boolean; rol?: Rol };

export type ResultadoCambiarEstado =
  | { ok: true }
  | { ok: false; motivo: 'no_encontrado' }
  | { ok: false; motivo: 'ultimo_superadmin' }
  | { ok: false; motivo: 'error'; error: string };

// Ronda de correcciones 1, Importante 3: esto contaba y escribía en dos
// pasos separados desde JavaScript — el mismo lee-y-decide sin atomicidad
// que ya se había rechazado una vez en la migración 0013 para el contador
// de intentos fallidos, y por el mismo motivo: con exactamente dos
// superadmins activos, dos peticiones concurrentes que degradan a uno cada
// una podían contar "2" las dos ANTES de que ninguna escribiera, y las dos
// pasar — dejando el equipo en CERO superadmins activos, un estado del que
// ninguna de las cuatro rutas de /api/equipo/* puede sacarlo (las cuatro
// EXIGEN un superadmin activo para entrar).
//
// El conteo y la escritura ahora son una sola llamada a
// `usuarios_panel_cambiar_estado` (supabase/migrations/0015_equipo_cambiar_estado.sql),
// que bloquea en la base las filas superadmin+activas antes de contar —
// igual que la 0013 hace con la fila individual que incrementa.
export async function cambiarEstado(
  db: Db,
  id: string,
  cambios: CambiosEstado,
): Promise<ResultadoCambiarEstado> {
  const { data, error } = await db.rpc(RPC_CAMBIAR_ESTADO, {
    p_id: id,
    p_activo: cambios.activo ?? null,
    p_rol: cambios.rol ?? null,
  });

  if (error) return { ok: false, motivo: 'error', error: error.message };
  if (data === 'no_encontrado') return { ok: false, motivo: 'no_encontrado' };
  if (data === 'ultimo_superadmin') return { ok: false, motivo: 'ultimo_superadmin' };
  // Ronda de correcciones 2: antes esto era un `return { ok: true }` sin
  // condición — cualquier `data` que no fuera ninguno de los dos motivos
  // de rechazo, incluido `null`, caía acá y la ruta respondía 200 sin que
  // se hubiera escrito nada. Hoy es inalcanzable (la función de Postgres
  // sólo devuelve estos tres textos), pero "inalcanzable hoy" no es una
  // garantía del tipo — es estricto a propósito: sólo `'ok'` cuenta como
  // éxito, y cualquier otra cosa es un error registrado, no un 200 fantasma.
  if (data === 'ok') return { ok: true };
  console.error(
    '[cotizador] La rpc de cambiar estado devolvió un valor inesperado.',
    id,
    JSON.stringify(data),
  );
  return { ok: false, motivo: 'error', error: `Valor inesperado de la base: ${String(data)}` };
}
