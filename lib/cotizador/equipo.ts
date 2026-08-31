import 'server-only';
import { normalizarCorreo, type Rol } from '@/lib/cotizador/usuarios';
import { generarInvitacion } from '@/lib/cotizador/invitaciones';
import { enviarInvitacion } from '@/lib/cotizador/correo-invitacion';
import type { DepsCorreo } from '@/lib/cotizador/correo';

// Mismo tipo inyectable que `lib/cotizador/usuarios.ts`, pero acotado a lo
// que este módulo necesita: acá no hay contador de intentos, así que no
// hace falta `rpc`. Definido acá y no importado de ahí para no acoplar este
// módulo a una función que no usa.
export type Db = { from: (tabla: string) => any };

const TABLA = 'usuarios_panel';

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
// Se relee por NOMBRE, no por id: es el mismo criterio de identidad que ya
// usa el resto del panel (la cookie sólo lleva el nombre, ver
// `lib/sesion.ts`); no hay un id de usuario viajando en la sesión.
export async function autorizarSuperadmin(
  vendedor: string,
  db: Db,
): Promise<{ ok: true; id: string } | { ok: false }> {
  const { data, error } = await db
    .from(TABLA)
    .select('id, rol, activo')
    .eq('nombre', vendedor)
    .maybeSingle();

  if (error || !data) return { ok: false };
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

export type ResultadoInvitar =
  | { ok: true; correoEnviado: boolean }
  | { ok: false; motivo: 'duplicado' }
  | { ok: false; motivo: 'error'; error: string };

export async function invitarPersona(
  db: Db,
  deps: DepsCorreo,
  datos: { correo: string; nombre: string; rol: Rol },
): Promise<ResultadoInvitar> {
  const correo = normalizarCorreo(datos.correo);
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
  const resultadoCorreo = await enviarInvitacion({ para: correo, nombre: datos.nombre, enlace }, deps);
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

  const { error: errorEscritura } = await db
    .from(TABLA)
    .update({ invitacion_hash: huella, invitacion_expira: expira.toISOString() })
    .eq('id', id);

  if (errorEscritura) return { ok: false, motivo: 'error', error: errorEscritura.message };

  const resultadoCorreo = await enviarInvitacion({ para: fila.correo, nombre: fila.nombre, enlace }, deps);
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

export async function cambiarEstado(
  db: Db,
  id: string,
  cambios: CambiosEstado,
): Promise<ResultadoCambiarEstado> {
  const { data, error: errorLectura } = await db
    .from(TABLA)
    .select('id, rol, activo')
    .eq('id', id)
    .maybeSingle();

  if (errorLectura) return { ok: false, motivo: 'error', error: errorLectura.message };
  if (!data) return { ok: false, motivo: 'no_encontrado' };

  const fila = data as { id: string; rol: Rol; activo: boolean };

  const nuevoRol = cambios.rol ?? fila.rol;
  const nuevoActivo = cambios.activo ?? fila.activo;

  const eraSuperadminActivo = fila.rol === 'superadmin' && fila.activo;
  const seguiraSuperadminActivo = nuevoRol === 'superadmin' && nuevoActivo;

  // Sólo hace falta contar cuando esta fila DEJA de ser un superadmin
  // activo: degradar a un vendedor, o reactivar a alguien, nunca puede
  // achicar ese conjunto.
  if (eraSuperadminActivo && !seguiraSuperadminActivo) {
    // Se cuenta EN LA BASE, justo antes de escribir — no sobre un número que
    // el llamador ya tenía a mano, que podría estar desactualizado. Como
    // `usuarios_panel_intento_fallido` (migración 0013), esto es un
    // lee-y-decide sin CAS: dos peticiones concurrentes que degradan a los
    // dos últimos superadmins A LA VEZ podrían colar ambas. Se acepta a
    // propósito, igual que la limitación documentada en
    // `lib/autenticacion-cotizador.ts`: esta acción la dispara a mano, desde
    // el panel, un superadmin de un equipo de unas pocas personas — el
    // riesgo real de esa carrera exacta no paga el costo de un
    // compare-and-swap de dos tablas acá.
    const { data: activos, error: errorConteo } = await db
      .from(TABLA)
      .select('id')
      .eq('rol', 'superadmin')
      .eq('activo', true);

    if (errorConteo) return { ok: false, motivo: 'error', error: errorConteo.message };
    if (((activos ?? []) as unknown[]).length <= 1) {
      return { ok: false, motivo: 'ultimo_superadmin' };
    }
  }

  const { error: errorEscritura } = await db.from(TABLA).update(cambios).eq('id', id);
  if (errorEscritura) return { ok: false, motivo: 'error', error: errorEscritura.message };

  return { ok: true };
}
