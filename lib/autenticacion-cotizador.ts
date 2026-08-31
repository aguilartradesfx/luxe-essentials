import 'server-only';
import { sesionDe, csrfValido } from '@/lib/sesion';
import type { Rol } from '@/lib/cotizador/usuarios';

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
// Revisión final, Importante 1 — LIMITACIÓN CONOCIDA Y ACEPTADA: dar de baja a
// alguien NO es inmediato.
//
// Esta función sólo mira la firma de la cookie; nunca vuelve a consultar la
// tabla. `activo` se comprueba una única vez, en `/entrar`. Así que
// `npm run usuarios -- desactivar <usuario>` impide entradas FUTURAS y deja a
// la persona desactivada trabajando con la sesión que ya tiene, hasta 30 días.
//
// Se aceptó a propósito. La alternativa correcta —meter el id del usuario en la
// cookie y consultar `activo` en cada petición— vuelve `autenticarPeticion`
// asíncrona en las doce rutas que la usan, y agrega una lectura a la base por
// cada llamada del panel, incluidas las que hoy no tocan la base. Es más
// trabajo y más latencia de los que esta fase necesita para un equipo de cinco
// personas.
//
// El remedio existe y está documentado: para sacar a alguien de verdad hay que
// `desactivar` Y ADEMÁS rotar `LUXE_SESION_SECRETO` en Vercel, lo que invalida
// todas las cookies vivas de una vez. Con cinco personas, que todos vuelvan a
// entrar una vez es trivial; y desde que la firma dejó de salir de
// `LUXE_TALLER_CLAVE` (Crítico 1), esa rotación ya no toca a `/q7m4`. El
// procedimiento está en README.md, y el propio script lo dice en consola al
// desactivar — lo que NO era defendible era dejarlo sin decidir, con un script
// que ofrece `desactivar` y quien lo corre creyendo que ya está.
// Tarea 3 (invitaciones y roles): el rol que devuelve esta función NO
// AUTORIZA NADA. Sale de la cookie firmada, así que no se puede falsificar,
// pero es un dato viejo desde el momento en que se emitió la sesión —hasta
// 30 días— y esta función no vuelve a tocar la base para confirmar que
// sigue siendo cierto. Sirve únicamente para que la interfaz decida qué
// dibujar (por ejemplo, ocultar la pantalla de equipo a quien no es
// superadmin). Las rutas de `/api/equipo/*` (tarea posterior) tienen que
// releer el rol desde la base antes de autorizar cualquier acción sobre
// otras cuentas — confiar en este campo ahí sería dejar a un superadmin
// recién degradado seguir administrando el equipo hasta que su cookie
// caduque.
export type ResultadoAutenticacion =
  | { ok: true; vendedor: string; rol: Rol }
  | { ok: false; status: number; error: string };

export function autenticarPeticion(
  request: Request,
  _crudo: unknown,
  opciones: { requiereCsrf: boolean },
): ResultadoAutenticacion {
  const sesion = sesionDe(request);
  if (!sesion) {
    // Dentro del iframe con las cookies de terceros bloqueadas, el vendedor
    // nunca llegó a tener sesión — no es que "venció". Un mensaje que sólo
    // dice "venció" lo manda a reintentar en círculo, como si volver a
    // escribir la clave fuera a arreglar algo que el navegador está
    // bloqueando de entrada. No se distingue el caso exacto (nunca hubo
    // sesión vs. expiró de verdad) a propósito: decírselo por separado le
    // diría a quien prueba con una cookie forjada cuál parte acertó.
    return { ok: false, status: 401, error: 'Tu sesión no está activa o venció. Volvé a entrar.' };
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

  return { ok: true, vendedor: sesion.nombre, rol: sesion.rol };
}
