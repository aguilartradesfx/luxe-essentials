import 'server-only';
import { verificarClave, gastarTiempoDeHash } from '@/lib/cotizador/credenciales.mjs';

// Mismo tipo inyectable que `lib/agente/estado.ts`: permite probar la lógica de
// intentos y bloqueo sin una base de datos.
export type Db = { from: (tabla: string) => any };

const TABLA = 'usuarios_panel';

// Cinco fallos seguidos y quince minutos. Es lo que hace que una tabla de
// credenciales sea mejor que una clave compartida y no sólo distinta: sin
// contador, probar claves contra este endpoint sale gratis. Quince minutos
// frena una fuerza bruta sin dejar a un vendedor fuera media mañana por
// escribir mal la clave cinco veces.
export const MAX_INTENTOS = 5;
export const BLOQUEO_MINUTOS = 15;

export type ResultadoEntrada =
  | { ok: true; nombre: string }
  | { ok: false; motivo: 'credenciales' | 'bloqueado' };

type FilaUsuario = {
  id: string;
  usuario: string;
  nombre: string;
  clave_hash: string;
  clave_sal: string;
  activo: boolean;
  intentos: number;
  bloqueado_hasta: string | null;
};

export function normalizarUsuario(usuario: string): string {
  return usuario.trim().toLowerCase();
}

export async function autenticarUsuario(
  usuario: string,
  clave: string,
  db: Db,
  ahora: Date = new Date(),
): Promise<ResultadoEntrada> {
  const nombreUsuario = normalizarUsuario(usuario);

  const { data, error } = await db
    .from(TABLA)
    .select('id, usuario, nombre, clave_hash, clave_sal, activo, intentos, bloqueado_hasta')
    .eq('usuario', nombreUsuario)
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

  const coincide = await verificarClave(clave, fila.clave_hash, fila.clave_sal);

  if (!coincide) {
    const intentos = fila.intentos + 1;
    if (intentos >= MAX_INTENTOS) {
      const hasta = new Date(ahora.getTime() + BLOQUEO_MINUTOS * 60 * 1000);
      // El contador vuelve a cero junto con el bloqueo: si se dejara en el
      // máximo, el primer fallo después de vencer el bloqueo volvería a
      // bloquear de inmediato y la cuenta quedaría en un ciclo del que sólo se
      // sale por consola.
      await escribir(db, fila.id, { intentos: 0, bloqueado_hasta: hasta.toISOString() });
      return { ok: false, motivo: 'bloqueado' };
    }
    await escribir(db, fila.id, { intentos });
    return { ok: false, motivo: 'credenciales' };
  }

  await escribir(db, fila.id, {
    intentos: 0,
    bloqueado_hasta: null,
    ultimo_acceso: ahora.toISOString(),
  });
  return { ok: true, nombre: fila.nombre };
}

// No lanza: si falla el registro del intento o del último acceso, la decisión
// de dejar entrar (o no) ya está tomada y es correcta. Hacer fallar la entrada
// por no poder anotar la contabilidad sería peor que perder la anotación.
async function escribir(db: Db, id: string, cambios: Record<string, unknown>): Promise<void> {
  const { error } = await db.from(TABLA).update(cambios).eq('id', id);
  if (error) {
    console.error('[cotizador] No se pudo actualizar el usuario del panel.', id, error.message);
  }
}
