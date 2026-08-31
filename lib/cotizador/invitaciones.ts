import 'server-only';
import { createHash, randomBytes } from 'node:crypto';

// El enlace son 32 bytes al azar (256 bits). Contra eso un contador de
// intentos no compra nada —no se adivina—, así que no se implementa: la fila
// se busca POR la huella, que es una igualdad indexada en la base y no una
// comparación en la aplicación.
//
// Se guarda la huella y no el enlace, por la misma razón que las claves van
// cifradas: quien lea la tabla no debe poder entrar como nadie. Acá alcanza
// SHA-256 y no hace falta `scrypt`, que existe para encarecer la fuerza bruta
// sobre secretos que un humano eligió; un valor al azar de 256 bits no tiene
// esa debilidad, y `scrypt` sólo haría lento cada clic del enlace.
export const HORAS_VIGENCIA = 72;

export function huellaDe(enlace: string): string {
  return createHash('sha256').update(enlace).digest('hex');
}

export function generarInvitacion(): { enlace: string; huella: string; expira: Date } {
  const enlace = randomBytes(32).toString('hex');
  return {
    enlace,
    huella: huellaDe(enlace),
    expira: new Date(Date.now() + HORAS_VIGENCIA * 3_600_000),
  };
}
