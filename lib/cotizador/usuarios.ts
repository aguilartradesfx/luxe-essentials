import 'server-only';
import { verificarClave, gastarTiempoDeHash } from '@/lib/cotizador/credenciales.mjs';

// Mismo tipo inyectable que `lib/agente/estado.ts`: permite probar la lógica de
// intentos y bloqueo sin una base de datos. Desde la revisión final incluye
// `rpc`: el conteo de intentos fallidos lo hace la base (ver `registrarFallo`,
// más abajo), así que el doble de pruebas tiene que saber responderlo.
export type Db = {
  from: (tabla: string) => any;
  // `PromiseLike` y no `Promise`: el cliente de Supabase devuelve un
  // constructor de consultas que sólo es *thenable*, no una promesa real.
  rpc: (nombre: string, argumentos: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>;
};

const TABLA = 'usuarios_panel';
// Nombre de la función de Postgres que cuenta el fallo y bloquea, en una sola
// sentencia (supabase/migrations/0013_usuarios_panel_intento_fallido.sql).
const RPC_INTENTO_FALLIDO = 'usuarios_panel_intento_fallido';

// Cinco fallos seguidos y quince minutos. Es lo que hace que una tabla de
// credenciales sea mejor que una clave compartida y no sólo distinta: sin
// contador, probar claves contra este endpoint sale gratis. Quince minutos
// frena una fuerza bruta sin dejar a un vendedor fuera media mañana por
// escribir mal la clave cinco veces.
export const MAX_INTENTOS = 5;
export const BLOQUEO_MINUTOS = 15;

// Lista cerrada de roles reales, con contraparte en tiempo de ejecución: un
// `type Rol = 'vendedor' | 'superadmin'` suelto sólo existe en tiempo de
// compilación, y un type predicate escrito a mano (`valor === 'vendedor' ||
// valor === 'superadmin'`) no lo valida contra el tipo — agregar un tercer rol
// al tipo compilaría limpio aunque el guard de `lib/sesion.ts` lo siguiera
// rechazando en silencio. `ROLES` es la única fuente de verdad; `Rol` se
// deriva de ella, y cualquier guard en tiempo de ejecución (`sesionDe`) debe
// leer de acá, no repetir los literales.
export const ROLES = ['vendedor', 'superadmin'] as const;
export type Rol = (typeof ROLES)[number];

export type ResultadoEntrada =
  | { ok: true; nombre: string; rol: Rol }
  | { ok: false; motivo: 'credenciales' | 'bloqueado' };

type FilaUsuario = {
  id: string;
  correo: string;
  nombre: string;
  rol: Rol;
  // Una persona invitada todavía no eligió su clave: la migración 0014 le
  // quitó el `not null` a estas dos columnas justo para permitir esa fila a
  // medio llenar.
  clave_hash: string | null;
  clave_sal: string | null;
  activo: boolean;
  intentos: number;
  bloqueado_hasta: string | null;
};

export function normalizarCorreo(correo: string): string {
  return correo.trim().toLowerCase();
}

export async function autenticarUsuario(
  correo: string,
  clave: string,
  db: Db,
  ahora: Date = new Date(),
): Promise<ResultadoEntrada> {
  const correoNormalizado = normalizarCorreo(correo);

  const { data, error } = await db
    .from(TABLA)
    .select('id, correo, nombre, rol, clave_hash, clave_sal, activo, intentos, bloqueado_hasta')
    .eq('correo', correoNormalizado)
    .maybeSingle();

  // Un fallo de lectura NO es "credenciales incorrectas". Devolverlo como tal
  // dejaría al equipo entero afuera con un mensaje que culpa a su clave,
  // mientras la causa real —la base caída— no aparece en ningún lado. Se lanza
  // para que la ruta lo convierta en un 500 visible.
  if (error) {
    throw new Error(`[cotizador] No se pudo leer el usuario del panel: ${error.message}`);
  }

  const fila = data as FilaUsuario | null;

  // Usuario inexistente o desactivado: se gasta el mismo tiempo que costaría
  // verificar una clave real. Sin esto, responder al instante frente a
  // responder en ~100 ms le dice a quien pruebe nombres cuáles existen. Y se
  // devuelve el mismo motivo que una clave mala, para no decirlo tampoco por
  // el mensaje.
  if (!fila || !fila.activo) {
    await gastarTiempoDeHash();
    return { ok: false, motivo: 'credenciales' };
  }

  if (fila.bloqueado_hasta) {
    const hasta = new Date(fila.bloqueado_hasta);
    // Una fecha ilegible se ignora en vez de bloquear para siempre: un dato
    // corrupto no debe dejar una cuenta inaccesible salvo por consola.
    if (Number.isFinite(hasta.getTime()) && hasta > ahora) {
      await gastarTiempoDeHash();
      return { ok: false, motivo: 'bloqueado' };
    }
  }

  // Una invitación pendiente no es una credencial: la fila existe y está
  // activa, pero `clave_hash`/`clave_sal` son nulos hasta que la persona entre
  // por el enlace y elija su clave. Se gasta igual el tiempo de hash y se
  // devuelve el mismo motivo que una clave mala — si no, responder distinto
  // (o al instante) delataría por tiempo o por mensaje qué correos tienen una
  // invitación esperando.
  if (fila.clave_hash === null || fila.clave_sal === null) {
    await gastarTiempoDeHash();
    return { ok: false, motivo: 'credenciales' };
  }

  const coincide = await verificarClave(clave, fila.clave_hash, fila.clave_sal);

  if (!coincide) {
    const bloqueada = await registrarFallo(db, fila.id, ahora);
    return { ok: false, motivo: bloqueada ? 'bloqueado' : 'credenciales' };
  }

  await escribir(db, fila.id, {
    intentos: 0,
    bloqueado_hasta: null,
    ultimo_acceso: ahora.toISOString(),
  });
  return { ok: true, nombre: fila.nombre, rol: fila.rol };
}

// Cuenta un intento fallido y, si toca, bloquea la cuenta. Devuelve si quedó
// bloqueada, para que la ruta pueda distinguir los dos motivos de rechazo.
//
// Revisión final, Importante 2: esto era un lee-modifica-escribe. Se leía
// `fila.intentos`, se sumaba uno en JavaScript y se escribía el valor absoluto
// — así que cien peticiones concurrentes leían todas `0` y escribían todas
// `1`. El atacante no obtenía cinco intentos sino cinco TANDAS de tamaño
// arbitrario, que es un debilitamiento de dos órdenes de magnitud sobre el
// único control que hace que una tabla de credenciales sea mejor que una clave
// compartida. Ahora el incremento y el bloqueo son una sola sentencia dentro
// de la base, sobre la fila que Postgres bloquea mientras la modifica.
//
// No lanza, por el mismo motivo que `escribir`: la decisión de rechazar ya
// está tomada y es correcta. Si la base no puede anotar el fallo, se pierde la
// anotación —y se registra ruidosamente— pero no se convierte un rechazo en un
// 500. El caso degradado es "sin contador", no "sin rechazo".
async function registrarFallo(db: Db, id: string, ahora: Date): Promise<boolean> {
  const { data, error } = await db.rpc(RPC_INTENTO_FALLIDO, {
    p_id: id,
    p_max_intentos: MAX_INTENTOS,
    p_bloqueo_minutos: BLOQUEO_MINUTOS,
    p_ahora: ahora.toISOString(),
  });
  if (error) {
    console.error(
      '[cotizador] No se pudo contar el intento fallido del panel.',
      id,
      error.message,
    );
    return false;
  }
  return data === true;
}

// No lanza: si falla el registro del último acceso, la decisión de dejar entrar
// ya está tomada y es correcta. Hacer fallar la entrada por no poder anotar la
// contabilidad sería peor que perder la anotación.
async function escribir(db: Db, id: string, cambios: Record<string, unknown>): Promise<void> {
  const { error } = await db.from(TABLA).update(cambios).eq('id', id);
  if (error) {
    console.error('[cotizador] No se pudo actualizar el usuario del panel.', id, error.message);
  }
}
