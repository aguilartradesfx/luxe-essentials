import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

// La bandeja de campañas manda a los ~3.340 contactos de la base comercial de
// una sola vez, con las cuatro plantillas que ya llevan
// `{{unsubscribe_url}}` en el pie. Armar ese enlace escribiendo una fila por
// contacto (un token al azar + una consulta para validarlo, como
// `lib/cotizador/invitaciones.ts`) volvería cada envío masivo una escritura
// por destinatario -- lento y frágil justo donde más contactos hay que
// tocar. Este módulo, en cambio, sigue el patrón de `lib/sesion.ts`: el
// enlace lleva el propio correo y una firma HMAC, así que se genera y se
// valida sin tocar la base para nada.
//
// Secreto PROPIO (`LUXE_BAJA_SECRETO`), nunca `LUXE_SESION_SECRETO`: son dos
// sistemas con vidas distintas. La cookie de sesión rota cuando hay que
// sacar a alguien del equipo (ver lib/sesion.ts) -- si compartiera secreto
// con la baja, esa rotación invalidaría de golpe todos los enlaces de baja
// ya mandados en correos que la gente puede abrir meses después (por
// diseño, este enlace NO caduca -- ver `correoDeToken`), y todo el que
// todavía no hubiera hecho clic volvería a poder recibir correos sin que
// nadie lo decidiera. Y al revés: rotar `LUXE_BAJA_SECRETO` porque un
// enlace de baja se filtró no debería tumbar la sesión de nadie en el panel.
//
// A diferencia de la cookie de sesión, este token NO lleva marca de tiempo:
// una campaña se abre meses después de mandada y el enlace del pie tiene
// que seguir funcionando. No hay nada que revocar tampoco -- darse de baja
// es una acción de una sola vía, así que no existe la sesión "vieja" que
// `lib/sesion.ts` necesita poder cortar.

function secreto(): string {
  return process.env.LUXE_BAJA_SECRETO ?? '';
}

function firmar(valor: string): string {
  return createHmac('sha256', secreto()).update(valor).digest('hex');
}

// Comparación en tiempo constante, mismo criterio que `lib/sesion.ts` y el
// resto del repositorio (app/api/q7m4/route.ts, app/api/cotizacion/*): un
// enlace falsificable dejaría dar de baja -- o, peor, dejar de dar de baja,
// ver más abajo -- a cualquier correo con sólo probar firmas.
function igualesEnTiempoConstante(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// Mismo criterio de normalización que `usuario` en `usuarios_panel`
// (migración 0012) y que `correo` en la misma tabla desde la 0014: minúsculas
// y sin espacios en los extremos. Se aplica siempre antes de firmar y
// siempre antes de comparar, para que "Ana@Hotel.com" y "ana@hotel.com"
// generen -- y acepten -- exactamente el mismo enlace.
export function normalizarCorreo(correo: string): string {
  return correo.trim().toLowerCase();
}

// Base64url por el mismo motivo que `codificarNombre` en `lib/sesion.ts`: el
// separador del formato del token es un punto, y un correo real no debería
// chocar con eso en el navegador ni en un log, así que se codifica.
function codificarCorreo(correo: string): string {
  return Buffer.from(correo, 'utf8').toString('base64url');
}

function decodificarCorreo(codificado: string): string | null {
  try {
    const correo = Buffer.from(codificado, 'base64url').toString('utf8');
    // Igual que `decodificarNombre` en `lib/sesion.ts`: un `base64url`
    // inválido no lanza, así que se comprueba el viaje de ida y vuelta para
    // no aceptar basura que decodifique a un correo vacío o distinto.
    if (!correo || codificarCorreo(correo) !== codificado) return null;
    return correo;
  } catch {
    return null;
  }
}

// El token es `<correo en base64url>.<firma>` -- dos partes, sin marca de
// tiempo (ver el comentario del encabezado: este enlace no caduca).
export function generarTokenBaja(correo: string): string {
  if (!secreto()) {
    throw new Error('LUXE_BAJA_SECRETO no está configurada: no se puede generar un enlace de baja.');
  }
  const normalizado = normalizarCorreo(correo);
  if (!normalizado) {
    throw new Error('No se puede generar un enlace de baja sin un correo.');
  }
  const codificado = codificarCorreo(normalizado);
  const firma = firmar(codificado);
  return `${codificado}.${firma}`;
}

// Devuelve el correo normalizado que firmó el token, o `null` si el token no
// es válido -- formato incorrecto, correo mal codificado, o firma que no
// coincide (incluida una firmada con otro `LUXE_BAJA_SECRETO`, por ejemplo
// tras una rotación). Es la función de verdad de todo este módulo: tanto la
// página pública (para mostrar "te vas a dar de baja de <correo>" sin tocar
// la base) como el endpoint de un clic (RFC 8058) la usan para decidir a
// quién excluir, y ninguno de los dos consulta nada más para llegar ahí.
export function correoDeToken(token: string): string | null {
  const esperado = secreto();
  if (!esperado) return null;

  // Dos partes exactas. Un token con más o menos puntos (por ejemplo, con un
  // correo que un `decodeURIComponent` a medias dejó con un punto suelto) no
  // valida -- no hay nada que "adivinar" en un formato distinto.
  const partes = token.split('.');
  if (partes.length !== 2) return null;
  const [codificado, firma] = partes;
  if (!codificado || !firma) return null;

  if (!igualesEnTiempoConstante(firma, firmar(codificado))) return null;

  return decodificarCorreo(codificado);
}

function urlSitio(): string {
  return process.env.NEXT_PUBLIC_SITE_URL || 'https://luxeessentialscr.com';
}

// La página pública que muestra la confirmación (Tarea 2). El link del pie
// de cada plantilla (`{{unsubscribe_url}}`) apunta acá -- una persona que
// hace clic ve con qué correo se va a dar de baja y tiene que tocar un botón
// aparte para que la baja de verdad ocurra (ver app/baja/PantallaBaja.tsx).
export function enlacePaginaBaja(correo: string): string {
  return `${urlSitio()}/baja?t=${generarTokenBaja(correo)}`;
}

// El endpoint de un solo POST que exige RFC 8058 (Tarea 3): a diferencia del
// enlace de arriba, a este nunca llega una persona navegando -- lo llama el
// propio servidor de Gmail o Yahoo cuando alguien toca "Cancelar
// suscripción" en su cliente de correo, sin mostrar ninguna pantalla. Por
// eso vive en /api/baja y no en /baja: son dos rutas de Next.js distintas a
// propósito (un `route.ts` y un `page.tsx` no pueden compartir la misma).
export function enlaceUnClicBaja(correo: string): string {
  return `${urlSitio()}/api/baja?t=${generarTokenBaja(correo)}`;
}

// Las dos cabeceras que exige RFC 8058 desde 2024 para que Gmail y Yahoo no
// penalicen la entrega de un envío masivo. `List-Unsubscribe-Post` es
// siempre este mismo valor fijo -- es lo que le dice al cliente de correo
// "sí, soporto la baja de un clic, mandame el POST sin preguntar" -- y
// `List-Unsubscribe` lleva la URL entre `<...>` (RFC 2369). La bandeja de
// campañas (todavía por construir) arma esto por destinatario y se lo pasa
// a Resend junto con el resto de las cabeceras del envío.
export function cabecerasListaBaja(correo: string): {
  'List-Unsubscribe': string;
  'List-Unsubscribe-Post': string;
} {
  return {
    'List-Unsubscribe': `<${enlaceUnClicBaja(correo)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
