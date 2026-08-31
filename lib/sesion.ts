import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ROLES, type Rol } from '@/lib/cotizador/usuarios';

// El panel vive embebido en un iframe de GoHighLevel (Tarea 6): la clave ya
// no puede pedirse en cada carga de pantalla, y por eso existe esta sesión
// por cookie. Desde la fase 3 es la ÚNICA credencial de las rutas del panel:
// la clave en el cuerpo dejó de autenticar (ver lib/autenticacion-cotizador.ts).
//
// Tarea 3 (usuarios del panel): la cookie ya no solo prueba que hubo una
// entrada válida — identifica a qué vendedor pertenece la sesión. El nombre
// viaja dentro del propio valor firmado (ver `emitirSesion` y `sesionDe`, más
// abajo).
//
// Tarea 3 de invitaciones-roles: la cookie suma un cuarto segmento con el rol
// (`'vendedor' | 'superadmin'`), también dentro del valor firmado. No es un
// secreto — cualquiera puede leer su propia cookie decodificando base64url —
// pero si viajara aparte de la firma, o la firma no lo cubriera, cualquier
// vendedor podría ascenderse a superadmin editando su propia cookie a mano.
//
// Ronda de correcciones 2 (Tarea 5, invitaciones y roles): la cookie suma un
// quinto segmento con el ID de la fila en `usuarios_panel`. Hasta acá la
// identidad de la sesión era el NOMBRE, y `autorizarSuperadmin`
// (lib/cotizador/equipo.ts) releía la fila buscándolo por nombre — pero los
// nombres no son únicos, y esa elección barata se pagó dos veces: primero
// como un bloqueo irreversible (invitar a alguien con el mismo nombre que
// un superadmin lo dejaba sin forma de autorizar nada), y después como una
// ventana de carrera en el propio chequeo que lo evita (nada impedía que dos
// inserciones simultáneas con el mismo nombre pasaran las dos el chequeo
// antes de que cualquiera escribiera). El id, en cambio, es la clave
// primaria de la tabla — único por definición de la base, no por disciplina
// de la aplicación — así que releer por id cierra el problema de raíz en vez
// de agregarle otro chequeo al costado. Por eso la firma se calcula ahora
// sobre `<emitidoEn>.<nombre>.<rol>.<id>` entero.
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
// `LUXE_SESION_SECRETO` (deliberado, tumba a todos los vendedores a la vez) —
// por eso la caducidad de abajo, verificada en el servidor y no solo
// declarada en `Max-Age`, es la que de verdad acota el daño. Esa rotación es
// también el segundo paso obligatorio para sacar a alguien del equipo: ver
// lib/autenticacion-cotizador.ts y la sección del panel en README.md.

const NOMBRE_COOKIE = 'luxe_sesion';
const MAX_EDAD_SEGUNDOS = 60 * 60 * 24 * 30; // 30 días.
const MAX_EDAD_MS = MAX_EDAD_SEGUNDOS * 1000;
// Margen de tolerancia de reloj para el chequeo de "emitida en el futuro",
// más abajo. El servidor que emite la cookie y el que la valida pueden no
// ser el mismo proceso (o el mismo momento exacto), y un reloj de sistema
// nunca está perfectamente sincronizado — sin margen, una diferencia de
// pocos segundos entre relojes bastaría para rechazar una cookie recién
// emitida y legítima. 60 segundos es generoso frente al desvío típico de NTP
// sin abrir una ventana real para una cookie forjada (ver el comentario de
// `sesionValida`, abajo: seguiría exigiendo la firma correcta).
const TOLERANCIA_RELOJ_MS = 60 * 1000;

function secreto(): string {
  // Revisión final, Crítico 1: hasta acá esta cookie se firmaba con
  // `LUXE_TALLER_CLAVE`, con el argumento de que era "un secreto de servidor".
  // No lo era: es la contraseña que una persona teclea en el formulario de
  // `/q7m4`, viaja en el cuerpo de cada petición a `/api/q7m4` y queda en
  // texto plano en el `sessionStorage` de toda máquina que haya usado el
  // taller. Quien la conociera podía fabricarse una cookie válida para
  // cualquier nombre — sin fila en `usuarios_panel`, sin `activo`, sin
  // contador de intentos. Era la llave maestra del panel, justo para las
  // personas frente a las que esta fase existe para cerrar la puerta.
  //
  // Ahora se firma con un secreto propio, que nadie teclea y que no sale del
  // servidor. NO hay respaldo a `LUXE_TALLER_CLAVE` si esta falta, a
  // propósito: un respaldo conservaría el agujero entero. Si falta, no se
  // emite ni se valida ninguna sesión — el mismo comportamiento que esta
  // función ya tenía ante un secreto ausente.
  //
  // `LUXE_TALLER_CLAVE` sigue existiendo y sigue siendo la clave de `/q7m4`,
  // que no se toca.
  return process.env.LUXE_SESION_SECRETO ?? '';
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

// El nombre viaja dentro del valor firmado y no en una cookie aparte: una
// segunda cookie sin firmar sería editable por el cliente, y "quién armó esta
// cotización" pasaría a ser un dato que el propio cliente elige. Va en
// `base64url` porque un nombre real trae tildes, espacios y a veces un punto —
// y el punto es el separador de este formato.
function codificarNombre(nombre: string): string {
  return Buffer.from(nombre, 'utf8').toString('base64url');
}

function decodificarNombre(codificado: string): string | null {
  try {
    const nombre = Buffer.from(codificado, 'base64url').toString('utf8');
    // Un `base64url` inválido no lanza: Buffer descarta lo que no reconoce y
    // devuelve algo. Se comprueba el viaje de ida y vuelta para no aceptar
    // basura que decodifique a un nombre vacío o distinto.
    if (!nombre || codificarNombre(nombre) !== codificado) return null;
    return nombre;
  } catch {
    return null;
  }
}

// El rol no se codifica en base64url como el nombre: los valores de `ROLES`
// no llevan tildes, espacios ni puntos, así que no chocan con el separador
// del formato. Se valida contra `ROLES` (lib/cotizador/usuarios.ts) y no
// contra literales repetidos acá — un type predicate escrito a mano no lo
// valida el compilador contra `Rol`, así que agregar un tercer rol al tipo
// sin agregarlo acá compilaría limpio y quedaría rechazado en silencio. Con
// `ROLES` como única fuente, agregar un rol es tocar un solo lugar. Ni
// "leído en claro" significa "de confianza".
function esRolValido(valor: string): valor is Rol {
  return (ROLES as readonly string[]).includes(valor);
}

// El id es el de la fila en `usuarios_panel` (`uuid primary key default
// gen_random_uuid()`) y viaja sin codificar, igual que el rol: un UUID no
// trae puntos ni otro carácter que choque con el separador de este
// formato. Se valida contra la forma canónica (8-4-4-4-12 hexadecimal),
// mismo criterio que `esRolValido` contra `ROLES`: la firma ya garantiza
// que nadie lo alteró después de emitido, pero un valor con una forma
// imposible no debería colar ni con la firma correcta — por ejemplo, si
// algún día se emitiera con un id vacío por error de programación.
const RE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function esIdValido(valor: string): boolean {
  return RE_ID.test(valor);
}

export function emitirSesion(nombre: string, rol: Rol, id: string): { cookie: string; csrf: string } {
  if (!secreto()) {
    throw new Error('LUXE_SESION_SECRETO no está configurada: no se puede emitir una sesión.');
  }
  // Una sesión sin vendedor no puede existir: firmaría cotizaciones con nadie.
  if (typeof nombre !== 'string' || nombre.trim().length === 0) {
    throw new Error('No se puede emitir una sesión sin el nombre del vendedor.');
  }
  // Igual con el rol: emitir una sesión con un valor fuera de la lista
  // cerrada dejaría una cookie que ninguna lectura futura podría aceptar (o
  // peor, una que `sesionDe` decida interpretar a su manera).
  if (!esRolValido(rol)) {
    throw new Error(`No se puede emitir una sesión con un rol inválido: ${String(rol)}`);
  }
  // Ronda de correcciones 2 (Tarea 5, invitaciones y roles): mismo criterio
  // que el rol — sin esta guarda, una sesión emitida con un id vacío o mal
  // formado quedaría sin forma de que `autorizarSuperadmin` la releyera
  // nunca, y el fallo aparecería lejos de acá, como un 403 que no dice por
  // qué.
  if (!esIdValido(id)) {
    throw new Error(`No se puede emitir una sesión con un id inválido: ${String(id)}`);
  }

  const emitidoEn = String(Date.now());
  const codificado = codificarNombre(nombre.trim());
  const contenido = `${emitidoEn}.${codificado}.${rol}.${id}`;
  const firma = firmar(contenido);
  const valor = `${contenido}.${firma}`;
  const csrf = derivarCsrf(valor);

  return { cookie: armarCookie(valor, MAX_EDAD_SEGUNDOS), csrf };
}

// Una sola fábrica para las dos cookies que emite este módulo — la de entrada
// y la de salida. El navegador sólo reemplaza (o borra) una cookie si el
// `Set-Cookie` nuevo trae exactamente los mismos atributos de identidad que el
// viejo: nombre, `Path`, y en este caso también `Secure`, `SameSite=None` y
// `Partitioned`, porque una cookie particionada vive en un frasco distinto del
// de una que no lo está. Armarlas por separado era la forma más fácil de
// escribir un "Salir" que no borra nada dentro del iframe de GoHighLevel.
function armarCookie(valor: string, maxEdadSegundos: number): string {
  return [
    `${NOMBRE_COOKIE}=${valor}`,
    'Path=/',
    `Max-Age=${maxEdadSegundos}`,
    'HttpOnly',
    'Secure',
    'SameSite=None',
    'Partitioned',
  ].join('; ');
}

// Revisión final, Importante 3: no existía ninguna ruta que caducara la
// cookie. En una computadora compartida —la recepción, la oficina— el segundo
// vendedor no tenía forma de dejar de ser el primero, y sus cotizaciones
// quedaban firmadas con el nombre equivocado de forma permanente e
// indistinguible: la fase había cambiado "una cotización no tiene autor" por
// algo peor, "tiene un autor, y es el equivocado".
//
// `Max-Age=0` es la forma estándar de pedirle al navegador que la borre ya. El
// valor va vacío para que, si algún navegador ignorara el `Max-Age`, lo que
// quede tampoco valide: una cadena vacía no pasa el formato de cinco partes.
export function cookieDeCierre(): string {
  return armarCookie('', 0);
}

// Devuelve el vendedor, el rol y el id de la sesión, o null si no hay una
// válida. Es la función de verdad: `sesionValida` es su versión booleana.
// Las mismas comprobaciones de siempre —firma, caducidad real en el
// servidor, emisión no futura— más el formato de cinco partes exactas, un
// rol de la lista cerrada y un id con forma de tal.
export function sesionDe(request: Request): { nombre: string; rol: Rol; id: string } | null {
  const esperado = secreto();
  if (!esperado) return null;

  const valor = obtenerCookie(request, NOMBRE_COOKIE);
  if (!valor) return null;

  // Cinco partes exactas. Una cookie de un formato anterior (cuatro partes,
  // sin id; o tres, sin rol) no valida: aceptarla dejaría entrar con una
  // sesión que no lleva el id que `autorizarSuperadmin` necesita para
  // releer la fila correcta — exactamente el hueco que este cambio cierra.
  const partes = valor.split('.');
  if (partes.length !== 5) return null;
  const [emitidoEnTexto, codificado, rolTexto, idTexto, firma] = partes;
  if (!emitidoEnTexto || !codificado || !rolTexto || !idTexto || !firma) return null;

  if (
    !igualesEnTiempoConstante(
      firma,
      firmar(`${emitidoEnTexto}.${codificado}.${rolTexto}.${idTexto}`),
    )
  ) {
    return null;
  }

  const emitidoEn = Number(emitidoEnTexto);
  if (!Number.isFinite(emitidoEn)) return null;

  const ahora = Date.now();
  if (emitidoEn > ahora + TOLERANCIA_RELOJ_MS) return null;
  if (ahora - emitidoEn > MAX_EDAD_MS) return null;

  if (!esRolValido(rolTexto)) return null;
  if (!esIdValido(idTexto)) return null;

  const nombre = decodificarNombre(codificado);
  if (!nombre) return null;

  return { nombre, rol: rolTexto, id: idTexto };
}

export function sesionValida(request: Request): boolean {
  return sesionDe(request) !== null;
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
