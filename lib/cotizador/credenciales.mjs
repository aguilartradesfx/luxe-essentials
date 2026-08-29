// JavaScript plano, no TypeScript, y a propósito: este módulo lo importan dos
// mundos —el servidor de Next.js (TypeScript) y `scripts/usuarios.mjs` (Node
// suelto)— y un `.mjs` no puede importar un `.ts`. Tener dos implementaciones
// del hash sería peor que este archivo raro: un usuario creado por el script no
// podría entrar por el panel, y el síntoma sería "la clave no me sirve" sin
// ninguna pista de por qué. `tsconfig.json` tiene `allowJs`, así que los tipos
// de JSDoc de abajo son los que ve el código TypeScript.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derivar = promisify(scrypt);

// Parámetros fijos. `N=16384` es el estándar de referencia de scrypt: unos 100
// ms y 16 MB por derivación en hardware corriente. Es deliberadamente lento —
// es lo único que hace cara una fuerza bruta contra la tabla si alguien se la
// lleva. Por eso el hash se calcula UNA vez, al entrar, y no en cada petición:
// la sesión por cookie es lo que evita repetirlo.
const N = 16384;
const R = 8;
const P = 1;
const LARGO_CLAVE = 64;
const LARGO_SAL = 16;

/**
 * @param {string} clave
 * @param {string} sal hexadecimal
 * @returns {Promise<Buffer>}
 */
function derivarCon(clave, sal) {
  return /** @type {Promise<Buffer>} */ (
    derivar(clave, Buffer.from(sal, 'hex'), LARGO_CLAVE, { N, r: R, p: P })
  );
}

/**
 * Deriva el hash de una clave con una sal nueva.
 * @param {string} clave
 * @returns {Promise<{ hash: string, sal: string }>}
 */
export async function hashClave(clave) {
  // Una clave vacía guardada en la tabla es una cuenta sin clave. Se corta acá
  // y no en el script, para que ninguna vía de alta futura pueda saltárselo.
  if (typeof clave !== 'string' || clave.length === 0) {
    throw new Error('La clave no puede estar vacía.');
  }
  const sal = randomBytes(LARGO_SAL).toString('hex');
  const hash = await derivarCon(clave, sal);
  return { hash: hash.toString('hex'), sal };
}

/**
 * Verifica una clave contra el hash y la sal guardados.
 * @param {string} clave
 * @param {string} hash hexadecimal
 * @param {string} sal hexadecimal
 * @returns {Promise<boolean>}
 */
export async function verificarClave(clave, hash, sal) {
  if (typeof clave !== 'string' || typeof hash !== 'string' || typeof sal !== 'string') {
    return false;
  }
  // Una fila corrupta o a medio escribir tiene que dar "no coincide", no una
  // excepción: si no, un dato malo en una fila tumba el endpoint de entrada
  // para el usuario que lo tenga.
  if (!/^[0-9a-f]+$/.test(hash) || !/^[0-9a-f]+$/.test(sal)) return false;
  if (hash.length !== LARGO_CLAVE * 2 || sal.length !== LARGO_SAL * 2) return false;

  try {
    const calculado = await derivarCon(clave, sal);
    const guardado = Buffer.from(hash, 'hex');
    // Mismo tamaño garantizado por el chequeo de largo de arriba, pero
    // `timingSafeEqual` lanza si no coinciden, así que se comprueba igual.
    return calculado.length === guardado.length && timingSafeEqual(calculado, guardado);
  } catch {
    return false;
  }
}

/**
 * Deriva contra una sal descartable. Existe para que autenticar a un usuario
 * inexistente cueste el mismo tiempo que autenticar a uno real: sin esto, la
 * diferencia entre responder al instante y responder en 100 ms le dice a quien
 * pruebe nombres cuáles existen.
 * @returns {Promise<void>}
 */
export async function gastarTiempoDeHash() {
  await derivarCon('credencial-inexistente', randomBytes(LARGO_SAL).toString('hex'));
}
