import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { sesionValida, csrfValido } from '@/lib/sesion';

// Ronda de correcciones 1 (Tarea 6): antes cada ruta de app/api/cotizacion/*
// repetía a mano "clave en el cuerpo o sesión válida, más CSRF si escribe".
// Repetido en cinco archivos, era fácil de olvidar en el sexto — el revisor
// probó quitar el bloque de CSRF entero de una ruta y las 529 pruebas
// seguían en verde, porque nada obligaba a que existiera. Centralizado acá,
// toda ruta que escriba lo llama una vez y no puede "olvidar" el CSRF sin
// que se note en el diff de esta función.

// Mismo criterio que app/api/q7m4/route.ts: comparación en tiempo constante,
// y sigue siendo la vía válida de siempre — esto no la reemplaza.
function claveValida(recibida: unknown): boolean {
  const esperada = process.env.LUXE_TALLER_CLAVE;
  if (!esperada || typeof recibida !== 'string') return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type ResultadoAutenticacion = { ok: true } | { ok: false; status: number; error: string };

// `requiereCsrf`: true en las rutas que escriben. Por clave en el cuerpo
// nunca se exige —un sitio ajeno no la conoce—, solo por sesión: la cookie
// necesita `SameSite=None` para vivir dentro del iframe de GoHighLevel, y
// eso hace que viaje sola en peticiones que origina cualquier otro sitio que
// el vendedor visite.
export function autenticarPeticion(
  request: Request,
  crudo: unknown,
  opciones: { requiereCsrf: boolean },
): ResultadoAutenticacion {
  // La credencial se revisa antes que el esquema de cada ruta: si alguien
  // sin credenciales manda un cuerpo mal formado, no debe recibir mensajes
  // de validación que revelen la forma esperada del cuerpo. Esta función no
  // toca el esquema — cada ruta sigue llamándola primero y parseando después.
  const claveRecibida =
    typeof crudo === 'object' && crudo !== null && 'clave' in crudo
      ? (crudo as { clave?: unknown }).clave
      : undefined;

  const porClave = claveValida(claveRecibida);
  const porSesion = !porClave && sesionValida(request);

  if (!porClave && !porSesion) {
    return { ok: false, status: 401, error: 'Clave incorrecta.' };
  }

  if (porSesion && opciones.requiereCsrf) {
    const csrfRecibido = request.headers.get('x-csrf-token') ?? undefined;
    if (!csrfValido(request, csrfRecibido)) {
      return { ok: false, status: 401, error: 'Token anti-CSRF inválido.' };
    }
  }

  return { ok: true };
}

// Reexportada para `/api/cotizacion/entrar`: esa ruta emite la sesión, así
// que valida la clave directamente (no acepta cookie — es el punto donde se
// consigue una).
export { claveValida };
