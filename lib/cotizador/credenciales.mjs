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

// Parámetros con los que se derivan los hashes NUEVOS. `N=65536` cuesta unos
// 400 ms y 64 MB por derivación en hardware corriente: deliberadamente lento,
// que es lo único que hace cara una fuerza bruta contra la tabla si alguien se
// la lleva. Por eso el hash se calcula UNA vez, al entrar, y no en cada
// petición: la sesión por cookie es lo que evita repetirlo.
//
// Revisión final, M1: estos valores eran constantes del módulo Y NO SE
// GUARDABAN con el hash, así que `verificarClave` derivaba siempre con los
// parámetros de HOY. El día que alguien subiera `N`, todos los hashes ya
// escritos dejaban de verificar en silencio y el síntoma era "a todo el mundo
// le dejó de servir la clave", sin ninguna pista de por qué. Ahora cada hash
// se guarda junto a los parámetros con los que se derivó (formato
// `scrypt$N$r$p$<hex>`) y `verificarClave` usa ESOS, no estos — así una subida
// futura de `N` sólo afecta a las claves que se creen después.
const N = 65536;
const R = 8;
const P = 1;
const LARGO_CLAVE = 64;
const LARGO_SAL = 16;
const ETIQUETA = 'scrypt';

// Cotas para los parámetros que vienen de una fila. No son un gusto de
// estilo: `N` y `r` deciden cuánta memoria pide `scrypt`, y esos números
// llegan desde la base. Una fila corrupta —o manipulada por quien tenga
// escritura en la tabla— con `N` enorme convertiría cada intento de entrada en
// una petición que reserva gigabytes. El techo está apenas por encima de lo
// que este proyecto usa: subirlo es un cambio deliberado de este archivo, no
// un dato que se pueda inyectar.
const N_MINIMO = 16384; // 2^14, el estándar de referencia de scrypt.
const N_MAXIMO = 262144; // 2^18.
const R_MAXIMO = 16;
const P_MAXIMO = 4;

// `scrypt` necesita del orden de 128 * N * r bytes. El `maxmem` por defecto de
// Node son 32 MB, que con N=65536 y r=8 (64 MB) ya no alcanza: sin este
// margen, `derivar` lanzaría en vez de derivar.
function maxmemPara(n, r) {
  return 128 * n * r * 2;
}

/**
 * @param {string} clave
 * @param {string} sal hexadecimal
 * @param {{ n?: number, r?: number, p?: number }} [parametros]
 * @returns {Promise<Buffer>}
 */
function derivarCon(clave, sal, parametros = {}) {
  const n = parametros.n ?? N;
  const r = parametros.r ?? R;
  const p = parametros.p ?? P;
  return /** @type {Promise<Buffer>} */ (
    derivar(clave, Buffer.from(sal, 'hex'), LARGO_CLAVE, {
      N: n,
      r,
      p,
      maxmem: maxmemPara(n, r),
    })
  );
}

/**
 * Lee un hash autodescriptivo `scrypt$N$r$p$<hex>`. Devuelve `null` si no tiene
 * esa forma, si la etiqueta no es la que este módulo sabe verificar, o si los
 * parámetros están fuera de las cotas de arriba. Nunca lanza: una fila mala
 * tiene que dar "no coincide", no tumbar el endpoint de entrada.
 * @param {string} hash
 * @returns {{ n: number, r: number, p: number, hex: string } | null}
 */
function leerHash(hash) {
  const partes = hash.split('$');
  if (partes.length !== 5) return null;

  const [etiqueta, nTexto, rTexto, pTexto, hex] = partes;
  if (etiqueta !== ETIQUETA) return null;

  const n = Number(nTexto);
  const r = Number(rTexto);
  const p = Number(pTexto);
  if (!Number.isInteger(n) || n < N_MINIMO || n > N_MAXIMO) return null;
  // `scrypt` exige que N sea potencia de dos; si no, lanza.
  if ((n & (n - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > R_MAXIMO) return null;
  if (!Number.isInteger(p) || p < 1 || p > P_MAXIMO) return null;

  if (!/^[0-9a-f]+$/.test(hex)) return null;
  if (hex.length !== LARGO_CLAVE * 2) return null;

  return { n, r, p, hex };
}

/**
 * Deriva el hash de una clave con una sal nueva. El hash devuelto lleva
 * incrustados los parámetros con los que se derivó.
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
  return { hash: `${ETIQUETA}$${N}$${R}$${P}$${hash.toString('hex')}`, sal };
}

/**
 * Verifica una clave contra el hash y la sal guardados, con los parámetros con
 * los que ESE hash se derivó — no con los del módulo.
 * @param {string} clave
 * @param {string} hash en formato `scrypt$N$r$p$<hex>`
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
  if (!/^[0-9a-f]+$/.test(sal) || sal.length !== LARGO_SAL * 2) return false;

  const parametros = leerHash(hash);
  if (!parametros) return false;

  try {
    const calculado = await derivarCon(clave, sal, parametros);
    const guardado = Buffer.from(parametros.hex, 'hex');
    // Mismo tamaño garantizado por el chequeo de largo de `leerHash`, pero
    // `timingSafeEqual` lanza si no coinciden, así que se comprueba igual.
    return calculado.length === guardado.length && timingSafeEqual(calculado, guardado);
  } catch {
    return false;
  }
}

/**
 * Deriva contra una sal descartable. Existe para que autenticar a un usuario
 * inexistente cueste el mismo tiempo que autenticar a uno real: sin esto, la
 * diferencia entre responder al instante y responder en cientos de
 * milisegundos le dice a quien pruebe nombres cuáles existen. Usa los
 * parámetros de HOY, que son los de las filas que se están creando.
 * @returns {Promise<void>}
 */
export async function gastarTiempoDeHash() {
  await derivarCon('credencial-inexistente', randomBytes(LARGO_SAL).toString('hex'));
}
