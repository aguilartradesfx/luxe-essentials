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

const NOMBRE_COOKIE = 'luxe_sesion';
const MAX_EDAD_SEGUNDOS = 60 * 60 * 24 * 30; // 30 días.

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
// puede ignorar). El token anti-CSRF se deriva del mismo valor firmado, así
// que solo quien emitió (o posee) la cookie puede producir el CSRF correcto.
function derivarCsrf(valorCookie: string): string {
  return firmar(`csrf.${valorCookie}`);
}

export function emitirSesion(): { cookie: string; csrf: string } {
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
  const emitidoEn = valor.slice(0, separador);
  const firma = valor.slice(separador + 1);
  if (!emitidoEn || !firma) return false;

  return igualesEnTiempoConstante(firma, firmar(emitidoEn));
}

export function csrfValido(request: Request, enviado: string | undefined): boolean {
  if (!enviado) return false;
  if (!sesionValida(request)) return false;

  const valor = obtenerCookie(request, NOMBRE_COOKIE);
  if (!valor) return false;

  return igualesEnTiempoConstante(enviado, derivarCsrf(valor));
}
