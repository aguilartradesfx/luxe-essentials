import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

// El panel vive embebido en un iframe de GoHighLevel (Tarea 6): la clave ya
// no puede pedirse en cada carga de pantalla, así que además de la clave en
// el cuerpo (que sigue siendo válida — la usan las rutas y sus pruebas) se
// suma esta sesión por cookie.
//
// La cookie necesita `SameSite=None` para que el navegador la mande dentro
// de un iframe de otro origen (app.gohighlevel.com). Esa es justo la
// condición que abre la puerta a CSRF: cualquier sitio que el vendedor
// visite puede disparar una petición al panel y el navegador adjunta la
// cookie solo. Por eso las rutas que escriben exigen, además de la cookie,
// un token anti-CSRF que viaja en una cabecera — algo que solo el propio
// panel puede leer y reenviar, porque un sitio ajeno no puede leer cabeceras
// ni cuerpo de respuestas de otro origen.
//
// Ronda de correcciones 1: sin identificador de sesión ni lista de
// revocación, una cookie filtrada es una credencial administrativa mientras
// siga siendo válida. La única forma de cortarla a mano es rotar
// `LUXE_TALLER_CLAVE` (deliberado, tumba a todos los vendedores a la vez) —
// por eso la caducidad de abajo, verificada en el servidor y no solo
// declarada en `Max-Age`, es la que de verdad acota el daño.

const NOMBRE_COOKIE = 'luxe_sesion';
const MAX_EDAD_SEGUNDOS = 60 * 60 * 24 * 30; // 30 días.
const MAX_EDAD_MS = MAX_EDAD_SEGUNDOS * 1000;

function secreto(): string {
  // Firmar con la misma clave del taller: si `LUXE_TALLER_CLAVE` cambia,
  // toda sesión viva deja de validar sola, sin lista de revocación aparte.
  // Deliberado — ver Tarea 6.
  return process.env.LUXE_TALLER_CLAVE ?? '';
}

function firmar(valor: string): string {
  return createHmac('sha256', secreto()).update(valor).digest('hex');
}

// Compara en tiempo constante, igual que el resto del repositorio
// (app/api/q7m4/route.ts, app/api/cotizacion/*). Longitudes distintas ya son
// una señal de "no coincide": timingSafeEqual exige el mismo tamaño de
// buffer, así que ese caso se corta antes sin pasar por ahí.
function igualesEnTiempoConstante(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function obtenerCookie(request: Request, nombre: string): string | null {
  const cabecera = request.headers.get('cookie');
  if (!cabecera) return null;
  for (const parte of cabecera.split(';')) {
    const igual = parte.indexOf('=');
    if (igual === -1) continue;
    const clave = parte.slice(0, igual).trim();
    if (clave === nombre) return parte.slice(igual + 1).trim();
  }
  return null;
}

// El valor de la cookie es `<emitidoEn>.<firma>`, con `emitidoEn` la marca de
// tiempo (ms) de emisión — se firma junto con el secreto para poder caducar
// la sesión sin depender solo de `Max-Age` del navegador (que el cliente
// puede ignorar, o mandar de vuelta intacta después de reescribirla — la
// firma es lo que hace que alterar `emitidoEn` a mano invalide la cookie).
// El token anti-CSRF se deriva del mismo valor firmado, así que solo quien
// emitió (o posee) la cookie puede producir el CSRF correcto.
function derivarCsrf(valorCookie: string): string {
  return firmar(`csrf.${valorCookie}`);
}

export function emitirSesion(): { cookie: string; csrf: string } {
  // Sin secreto no hay firma que valga nada: emitir de todos modos daría una
  // cookie de aspecto normal que `sesionValida` rechazaría (ella sí tenía
  // esta guarda), pero es mejor fallar acá, fuerte y temprano, que dejar
  // circular una cookie que nunca va a servir. Hoy es inalcanzable —
  // `/api/cotizacion/entrar` ya exige la clave antes de llamar a esta
  // función, y sin `LUXE_TALLER_CLAVE` esa validación siempre falla— pero la
  // gemela (`sesionValida`) tiene esta misma guarda y no hay razón para que
  // esta no la tenga.
  if (!secreto()) {
    throw new Error('LUXE_TALLER_CLAVE no está configurada: no se puede emitir una sesión.');
  }

  const emitidoEn = String(Date.now());
  const firma = firmar(emitidoEn);
  const valor = `${emitidoEn}.${firma}`;
  const csrf = derivarCsrf(valor);

  const cookie = [
    `${NOMBRE_COOKIE}=${valor}`,
    'Path=/',
    `Max-Age=${MAX_EDAD_SEGUNDOS}`,
    'HttpOnly',
    'Secure',
    'SameSite=None',
    // `SameSite=None` sin esto hace que, dentro del iframe de GoHighLevel,
    // la cookie sea "de terceros": Safari la bloquea de plano y Chrome puede
    // hacerlo. El síntoma sería que la sesión nunca persiste y el panel pide
    // la clave en cada carga — justo el problema que esta tarea existe para
    // resolver. `Partitioned` (CHIPS) la particiona por sitio de nivel
    // superior en vez de tratarla como third-party clásica.
    'Partitioned',
  ].join('; ');

  return { cookie, csrf };
}

export function sesionValida(request: Request): boolean {
  const esperado = secreto();
  if (!esperado) return false;

  const valor = obtenerCookie(request, NOMBRE_COOKIE);
  if (!valor) return false;

  const separador = valor.indexOf('.');
  if (separador === -1) return false;
  const emitidoEnTexto = valor.slice(0, separador);
  const firma = valor.slice(separador + 1);
  if (!emitidoEnTexto || !firma) return false;

  if (!igualesEnTiempoConstante(firma, firmar(emitidoEnTexto))) return false;

  // Ronda de correcciones 1 (hallazgo crítico): la firma por sí sola no
  // caduca nada — solo prueba que esta app emitió la cookie en algún
  // momento. `Max-Age` es una instrucción para el navegador, no una que el
  // servidor pueda confiar en que se respetó (una cookie reenviada a mano,
  // o un navegador que la conserva más de la cuenta, la manda igual). La
  // caducidad real vive acá.
  const emitidoEn = Number(emitidoEnTexto);
  if (!Number.isFinite(emitidoEn)) return false;

  const ahora = Date.now();

  // Una fecha de emisión posterior a "ahora" no tiene explicación legítima
  // (el reloj del servidor no retrocede entre la emisión y la validación):
  // es la marca de una cookie forjada con una firma que de casualidad
  // coincidiera, o una manipulación del reloj. Se corta acá, no solo por
  // higiene — sin este freno, una fecha en el año 3000 sería válida para
  // siempre.
  if (emitidoEn > ahora) return false;

  if (ahora - emitidoEn > MAX_EDAD_MS) return false;

  return true;
}

export function csrfValido(request: Request, enviado: string | undefined): boolean {
  if (!enviado) return false;
  if (!sesionValida(request)) return false;

  const valor = obtenerCookie(request, NOMBRE_COOKIE);
  if (!valor) return false;

  return igualesEnTiempoConstante(enviado, derivarCsrf(valor));
}

// Ronda de correcciones 1 (Tarea 9, hallazgo crítico): el token anti-CSRF
// solo se entregaba en la respuesta de `/api/cotizacion/entrar`, y esa
// respuesta viajaba una única vez. Guardarlo del lado del cliente en
// `sessionStorage` (por pestaña, se pierde al cerrarla) dejaba la
// credencial durable de verdad —esta cookie, 30 días, `Partitioned`— detrás
// del almacenamiento más frágil del navegador: pestaña nueva, navegador
// reabierto, o `sessionStorage` bloqueado (Safari/modo privado) y la sesión
// nunca persistía, pese a que la cookie sí era válida.
//
// La función expone el mismo token que ya calcula `csrfValido` para
// verificar, pero en sentido inverso: dado un request con una cookie
// válida, devuelve el token que le correspondería. Es seguro porque el
// token es una función determinista de la cookie (`HMAC(secreto, "csrf." +
// valorCookie)`) — devolvérselo a quien ya demuestra tener la cookie válida
// no le concede ninguna capacidad que no tuviera ya. `null` si no hay una
// sesión válida (sin cookie, cookie vencida, o firmada con otra clave):
// nunca se inventa un token para quien no la tiene.
export function csrfDeSesion(request: Request): string | null {
  if (!sesionValida(request)) return null;
  const valor = obtenerCookie(request, NOMBRE_COOKIE);
  if (!valor) return null;
  return derivarCsrf(valor);
}
