import 'server-only';
import { sesionDe, csrfValido } from '@/lib/sesion';
import type { Rol } from '@/lib/cotizador/usuarios';
import { supabaseAdmin } from '@/lib/supabase/server';

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
//
// I6 (revision-final-2.md), arreglado: hasta acá esta función sólo miraba la
// firma de la cookie y nunca volvía a tocar la base -- `activo` se
// comprobaba una única vez, en `/entrar`. `npm run usuarios -- desactivar
// <usuario>` impedía entradas FUTURAS, pero dejaba a la persona ya
// desactivada trabajando con la sesión que ya tenía hasta 30 días (lo que
// dura la cookie, ver lib/sesion.ts), y el único remedio real era rotar
// `LUXE_SESION_SECRETO` a mano -- documentado, pero un segundo paso que
// nadie estaba obligado a recordar. Esa concesión se tasó para un panel de
// cotizaciones de un equipo de cinco; desde entonces la misma cookie da
// acceso a mandar correo (PDF por Resend, Estimate en GoHighLevel) en
// nombre de Luxe a cualquier hotel del libro, así que el cálculo ya no se
// sostiene.
//
// Ahora `autenticarPeticion` relee `activo`/`rol` de `usuarios_panel` por el
// id de la cookie, con una caché en memoria de vida corta (`CACHE_TTL_MS`,
// más abajo) para no convertir cada clic del panel en una lectura a la
// base: dar de baja a alguien surte efecto dentro de esa ventana, nunca más
// tarde, en vez de hasta un mes después. `rol` también sale fresco de acá
// cuando la lectura tiene éxito -- ya no del valor que traía la cookie el
// día que se firmó (ver el `return` final).
//
// Se vuelve asíncrona por esto -- las veintiséis rutas que la llaman
// (`grep -rl "autenticarPeticion(request" app/api | wc -l`) ahora hacen
// `await autenticarPeticion(...)`. El comentario original de esta función
// hablaba de "doce rutas": ese número quedó desactualizado por las ocho de
// `app/api/campanas/*` (fase de campañas) y no reflejaba ya el tamaño real
// del cambio -- se corrige acá.
//
// El remedio manual (rotar `LUXE_SESION_SECRETO`) ya NO hace falta como
// segundo paso obligatorio: `README.md` y `scripts/usuarios.mjs` se
// actualizan junto con este archivo para dejar de pedirlo. Sigue sirviendo
// como último recurso -- tumba a todo el equipo de una vez, útil si se
// sospecha que una cookie se filtró de verdad-- pero desactivar ya no
// depende de él para surtir efecto.
//
// Tarea 3 (usuarios del panel): la cookie ya no solo prueba que hubo una
// entrada válida — identifica a qué vendedor pertenece la sesión. El nombre
// viaja dentro del propio valor firmado (ver `emitirSesion` y `sesionDe`,
// lib/sesion.ts).
//
// Tarea 3 de invitaciones-roles / Ronda de correcciones 2 (Tarea 5): la
// cookie también lleva el rol y el id de la fila en `usuarios_panel`,
// firmados junto con el resto. Antes de este arreglo el comentario de acá
// decía que el `rol` "no autoriza nada" y que sólo servía para que la
// interfaz decidiera qué dibujar -- eso seguía siendo cierto para las rutas
// de equipo/aprobaciones/campañas, que YA releían con `autorizarSuperadmin`
// (lib/cotizador/equipo.ts) antes de actuar sobre otras cuentas. Ahora que
// `autenticarPeticion` también relee, el `rol` que devuelve es fresco
// siempre que la lectura tenga éxito -- pero `autorizarSuperadmin` sigue
// siendo quien decide de verdad para las acciones de superadmin: dos
// lecturas independientes, no una que reemplaza a la otra.
export type ResultadoAutenticacion =
  | { ok: true; vendedor: string; rol: Rol; id: string }
  | { ok: false; status: number; error: string };

const TABLA_USUARIOS = 'usuarios_panel';

// Un minuto: lo bastante corto para que desactivar a alguien surta efecto
// pronto (antes de este arreglo, hasta 30 días -- lo que dura la cookie),
// y lo bastante largo para que un vendedor armando varias cotizaciones
// seguidas, o el panel refrescando el catálogo en cada pestaña, no
// conviertan cada clic en una lectura a la base. No es una promesa de
// "menos de un minuto siempre" -- es cuánto puede tardar, como mucho, en
// una instancia que ya tenía a esa persona en caché.
const CACHE_TTL_MS = 60_000;

type EntradaCache = { activo: boolean; rol: Rol; expiraEn: number };

// Caché EN MEMORIA, por instancia -- no hay Redis ni tabla de sesiones en
// este proyecto, y agregar una para esto sería más infraestructura de la
// que un panel de cinco personas necesita. En Vercel cada instancia de
// función es efímera: esta caché no persiste entre despliegues ni se
// comparte entre instancias frías, así que el "menos de un minuto" de
// arriba es por instancia, no una garantía global -- una instancia recién
// arrancada siempre relee. Eso es aceptable: el objetivo es cerrar la
// ventana de "hasta 30 días", no perseguir el milisegundo.
const cache = new Map<string, EntradaCache>();

// Sólo para pruebas: cada archivo de pruebas que ejercita rutas reales
// arranca con la caché vacía, igual que reinicia cualquier otro estado
// module-level (`filas`, `cotizaciones`, etc. en sus propios dobles) --
// Vitest no reimporta este módulo entre pruebas del mismo archivo, así que
// sin este reset una fila desactivada en una prueba podría seguir
// devolviendo "activa" en la siguiente si compartieran el id.
export function _reiniciarCacheAutenticacion(): void {
  cache.clear();
}

// Relee `activo`/`rol` de la fila, con la caché de arriba por delante.
//
// Devuelve `null` cuando la LECTURA a la base falla (error de red, Supabase
// caído) -- nunca cuando la fila dice `activo: false` o no existe, que son
// respuestas válidas, no fallos. `null` es la señal de "no se pudo
// averiguar", y es la que `autenticarPeticion` usa para decidir el criterio
// de abajo.
async function estadoFrescoDe(id: string): Promise<{ activo: boolean; rol: Rol } | null> {
  const ahora = Date.now();
  const enCache = cache.get(id);
  // `enCache.expiraEn > ahora`, nunca `>=`: al segundo exacto de vencer, se
  // trata como vencida. La caché no puede devolver "activo" un instante
  // después de su propia vida útil.
  if (enCache && enCache.expiraEn > ahora) {
    return { activo: enCache.activo, rol: enCache.rol };
  }

  // `try/catch`, no sólo mirar `error`: `supabaseAdmin()` puede LANZAR de
  // entrada (credenciales faltantes, ver lib/supabase/server.ts) en vez de
  // resolver con `{ data: null, error }` -- un despliegue con esa
  // configuración rota no puede convertirse en "nadie del equipo puede usar
  // el panel", que es exactamente lo que I6 pide evitar. Cualquier
  // excepción de este bloque cae en el mismo camino de fail-open que un
  // `error` normal, más abajo.
  let data: unknown;
  let error: { message: string } | null;
  try {
    const resultado = await supabaseAdmin()
      .from(TABLA_USUARIOS)
      .select('id, rol, activo')
      .eq('id', id)
      .maybeSingle();
    data = resultado.data;
    error = resultado.error;
  } catch (excepcion) {
    data = null;
    error = { message: excepcion instanceof Error ? excepcion.message : String(excepcion) };
  }

  if (error) {
    // Fail-open, a propósito -- y distinto del criterio de
    // `autorizarSuperadmin` (lib/cotizador/equipo.ts), que falla CERRADO en
    // el mismo caso. La diferencia no es un descuido: `autorizarSuperadmin`
    // sólo gatea acciones de superadmin (equipo, aprobaciones, campañas) --
    // un blip de la base ahí deja sin ese panel a UNA persona, por un rato.
    // `autenticarPeticion` gatea TODO el panel para TODOS -- vendedores
    // armando cotizaciones incluidos. Fallar cerrado acá echaría al equipo
    // entero de su herramienta de trabajo diaria por cada corte transitorio
    // de Supabase, que es exactamente el daño que I6 pide evitar. No se
    // cachea el resultado: la próxima petición reintenta la base, así que
    // esta puerta trasera dura, como mucho, lo que dure la caída real --
    // nunca más que eso, y nunca el resto del minuto de caché.
    console.error(
      '[cotizador] No se pudo releer el usuario para autenticar la petición; se deja pasar con los datos de la cookie (fail-open).',
      id,
      error.message,
    );
    return null;
  }

  if (!data) {
    // La fila ya no existe -- no sólo desactivada, borrada. Se cachea igual
    // que un `activo: false`: no hay ningún cambio futuro que pueda
    // "reactivar" una fila que no está.
    console.error('[cotizador] La cookie trae un id sin fila en usuarios_panel al autenticar.', id);
    cache.set(id, { activo: false, rol: 'vendedor', expiraEn: ahora + CACHE_TTL_MS });
    return { activo: false, rol: 'vendedor' };
  }

  const fila = data as { id: string; rol: Rol; activo: boolean };
  cache.set(id, { activo: fila.activo, rol: fila.rol, expiraEn: ahora + CACHE_TTL_MS });
  return { activo: fila.activo, rol: fila.rol };
}

export async function autenticarPeticion(
  request: Request,
  _crudo: unknown,
  opciones: { requiereCsrf: boolean },
): Promise<ResultadoAutenticacion> {
  const sesion = sesionDe(request);
  if (!sesion) {
    // Dentro del iframe con las cookies de terceros bloqueadas, el vendedor
    // nunca llegó a tener sesión — no es que "venció". Un mensaje que sólo
    // dice "venció" lo manda a reintentar en círculo, como si volver a
    // escribir la clave fuera a arreglar algo que el navegador está
    // bloqueando de entrada. No se distingue el caso exacto (nunca hubo
    // sesión vs. expiró de verdad) a propósito: decírselo por separado le
    // diría a quien prueba con una cookie forjada cuál parte acertó. Mismo
    // criterio para "te desactivaron" (ver más abajo): un mensaje aparte
    // le confirmaría a quien fue dado de baja que su cookie SÍ era válida.
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

  const fresco = await estadoFrescoDe(sesion.id);

  // `fresco === null`: la base no respondió -- fail-open (ver el comentario
  // de `estadoFrescoDe`). `fresco.activo === false`: la fila dice
  // desactivada, o ya no existe -- las dos rechazan, con el mismo mensaje
  // genérico que una cookie vencida.
  if (fresco && !fresco.activo) {
    return { ok: false, status: 401, error: 'Tu sesión no está activa o venció. Volvé a entrar.' };
  }

  // El rol sale fresco de la base cuando la lectura tuvo éxito -- nunca del
  // valor que traía la cookie el día que se firmó, que puede llevar hasta
  // 30 días de atraso. Sólo cae al de la cookie cuando `estadoFrescoDe`
  // devolvió `null` (fail-open): en ese caso no hay ningún dato más nuevo
  // con el que reemplazarlo.
  return { ok: true, vendedor: sesion.nombre, rol: fresco ? fresco.rol : sesion.rol, id: sesion.id };
}
