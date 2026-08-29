import 'server-only';
import { nombreDeSesion, csrfValido } from '@/lib/sesion';

// Fase 3: la clave compartida en el cuerpo dejó de ser una credencial válida.
// Antes esta función aceptaba dos vías —clave o cookie— y la clave se conservó
// deliberadamente como respaldo de disponibilidad: si la cookie se caía dentro
// del iframe, el vendedor podía seguir escribiendo. Con credenciales por
// persona ese respaldo ya no puede existir: verificar un hash `scrypt` en cada
// petición costaría ~100 ms por llamada, y aceptar la clave compartida
// mantendría abierta la puerta que esta fase cierra. La cookie es ahora la
// única credencial, y el modo de fallo es mejor que el de antes: se falla al
// entrar, con un mensaje claro, en vez de dejar un panel que se lee entero y
// no escribe nada.
export type ResultadoAutenticacion =
  | { ok: true; vendedor: string }
  | { ok: false; status: number; error: string };

export function autenticarPeticion(
  request: Request,
  _crudo: unknown,
  opciones: { requiereCsrf: boolean },
): ResultadoAutenticacion {
  const vendedor = nombreDeSesion(request);
  if (!vendedor) {
    return { ok: false, status: 401, error: 'Tu sesión venció. Volvé a entrar.' };
  }

  // La cookie necesita `SameSite=None` para vivir dentro del iframe de
  // GoHighLevel, y eso hace que viaje sola en peticiones que origina cualquier
  // otro sitio que el vendedor visite. Las rutas que escriben exigen además el
  // token derivado, que sólo el propio panel puede leer y reenviar.
  if (opciones.requiereCsrf) {
    const csrfRecibido = request.headers.get('x-csrf-token') ?? undefined;
    if (!csrfValido(request, csrfRecibido)) {
      return { ok: false, status: 401, error: 'Token anti-CSRF inválido.' };
    }
  }

  return { ok: true, vendedor };
}
