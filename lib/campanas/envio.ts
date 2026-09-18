import 'server-only';
import type { Permitido } from '@/lib/campanas/exclusiones';
import type { DestinatarioCampana } from '@/lib/campanas/contactos';
import { normalizarCorreo, enlacePaginaBaja, cabecerasListaBaja } from '@/lib/campanas/baja';
import { renderizarPlantilla, inyectarVistaPrevia } from '@/lib/campanas/marcadores';

// Crea una campaña (con su lista fija de destinatarios) y la manda por
// tandas, retomables -- ver el comentario grande de la migración 0019
// (supabase/migrations/0019_campanas.sql) para el diseño completo de la
// tabla `campanas_envios` y de `campanas_reclamar_pendientes`, que es lo
// que hace posible todo lo de acá.

const RESEND_BATCH_URL = 'https://api.resend.com/emails/batch';

// Las cuatro plantillas fijas (Tarea 2 de la bandeja de campañas): la
// inicial y tres seguimientos, cada una con su .html en
// lib/campanas/plantillas/. Vive acá también para que escribir una quinta
// FIJA sea un error de TypeScript en vez de un 23514 de Postgres recién al
// desplegar. Sigue siendo el arreglo que usa lib/campanas/plantillas.ts
// para saber qué cuatro archivos cargar de disco -- por eso NO incluye
// 'personalizada' (más abajo): esa quinta opción no tiene ningún archivo
// que cargar, así que mezclarla acá rompería `ARCHIVOS`/`CARGADAS` en ese
// módulo.
export const PLANTILLAS = ['inicial', 'seguimiento_1', 'seguimiento_2', 'seguimiento_3'] as const;
export type PlantillaFija = (typeof PLANTILLAS)[number];

// La quinta opción (encargo del dueño): HTML pegado a mano por quien arma
// la campaña, en vez de una de las cuatro fijas. Aparte de `PLANTILLAS` por
// el motivo de arriba -- plantillas.ts sigue iterando sólo `PLANTILLAS`
// para cargar los cuatro .html de disco, sin ningún cambio. El html, el
// asunto y el preview_text de una campaña 'personalizada' los aporta CADA
// campaña (lib/campanas/plantilla-personalizada.ts los sanea y valida antes
// de que lleguen a `crearCampana`), no el repositorio.
export const PLANTILLA_PERSONALIZADA = 'personalizada' as const;

// Mismo valor que el `check` de `campanas.plantilla` (migraciones 0019 y
// 0021) -- las cinco opciones válidas para una fila de `campanas`.
export const TODAS_LAS_PLANTILLAS = [...PLANTILLAS, PLANTILLA_PERSONALIZADA] as const;
export type PlantillaCampana = (typeof TODAS_LAS_PLANTILLAS)[number];

// El tamaño de tanda es el máximo que acepta el endpoint de LOTE de Resend
// (`POST /emails/batch`, hasta 100 correos por llamada -- ver
// https://resend.com/docs/api-reference/emails/send-batch-emails). Con
// esto, cada tanda manda TODOS sus correos en una única petición HTTP a
// Resend, en vez de hasta cien peticiones sueltas: lo que mantiene una
// tanda rápida (un puñado de consultas cortas a la base + una sola llamada
// a Resend, todo en segundos) sin que importe cuánto tarde el servidor en
// cortar la petición que la disparó. Una campaña de 3.340 destinatarios se
// manda en 34 tandas.
export const TAMANO_TANDA = 100;

// Cuánto puede durar reservada una fila 'pendiente' antes de considerarse
// abandonada y volver a quedar disponible. Generoso frente a lo que de
// verdad tarda una tanda (una llamada a Resend + un puñado de consultas,
// segundos) y corto frente a lo que un operador espera antes de que
// "retomar" la campaña la vuelva a recoger sola, sin intervención manual.
export const MINUTOS_RESERVA_VENCIDA = 15;

const RPC_RECLAMAR = 'campanas_reclamar_pendientes';
// Migración 0023 -- ver el comentario grande junto a su única llamada, más
// abajo en `enviarTanda`, sobre por qué cerrar una tanda es esta única
// llamada y no cien `.update()` sueltos.
const RPC_CERRAR_TANDA = 'campanas_cerrar_tanda';

// Mismo tipo laxo que `Db` en lib/cotizador/usuarios.ts: alcanza con
// `.from()` y `.rpc()` para poder probar este módulo con un doble de
// Supabase en memoria. `rpc` devuelve `PromiseLike`, no `Promise`, porque
// el cliente real de Supabase entrega un constructor de consulta que sólo
// es *thenable*.
export type ClienteCampanas = {
  from: (tabla: string) => any;
  rpc: (nombre: string, argumentos: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>;
};

export type ParamsCrearCampana = {
  // Punto 2 del encargo (hallazgo importante, revisión final): a qué zona
  // comercial se le escribe -- una de las trece de ZONAS_COMERCIALES
  // (lib/campanas/contactos.ts). Se guarda tal cual la validó
  // `Entrada.zona` (`z.enum(ZONAS_COMERCIALES)`) en
  // app/api/campanas/crear/route.ts -- este módulo no vuelve a validarla
  // contra esa lista (sería duplicar el enum acá) -- ver el comentario
  // grande de la migración 0022 sobre por qué la columna no lleva su
  // propio `check`. Sin esto no había forma de saber, mirando el
  // historial, a qué zonas ya se les escribió.
  zona: string;
  plantilla: PlantillaCampana;
  asunto: string;
  previewText?: string;
  // El HTML final, con los tres marcadores {{nombre}}/{{empresa}}/
  // {{unsubscribe_url}} todavía sin resolver -- se resuelven por
  // destinatario en `enviarTanda`.
  html: string;
  creadoPor: string;
  // Envío programado (cron, lib/campanas/programado.ts): `true` cuando esta
  // campaña la arma sola el cron diario, `false`/ausente para cualquier
  // campaña armada a mano desde la pantalla -- que sigue siendo el caso de
  // toda campaña de HOY, de seguimiento, o 'personalizada'. Es lo que deja
  // a `lib/campanas/programado.ts` encontrar "la campaña de la zona actual"
  // por columna (migración 0027) en vez de adivinar por `creado_por` (un
  // texto libre que además ya identifica a un vendedor humano en el resto
  // de las campañas). Por defecto `false` -- ninguna llamada existente
  // (crear/route.ts, ni las pruebas de este módulo) pasa este campo, así
  // que ninguna sigue creando campañas 'programada: true' por accidente.
  programada?: boolean;
};

export type ResultadoCrearCampana =
  | { ok: true; campanaId: string; destinatarios: number }
  | { ok: false; error: string };

// El único punto de entrada para armar una campaña. `destinatarios` exige
// `Permitido<T>` (lib/campanas/exclusiones.ts) -- un tipo que SÓLO
// `filtrarPermitidosParaCampana` puede producir -- así que mandar la lista
// cruda de contactos, sin pasar antes por el filtro de bajas, no compila.
// No es una convención que alguien tiene que acordarse de seguir: es un
// error de TypeScript, igual que documenta el comentario de `Permitido<T>`
// en exclusiones.ts.
//
// Escribe dos cosas: la fila de `campanas` y una fila 'pendiente' en
// `campanas_envios` por cada destinatario -- esa segunda escritura es la
// que FIJA la lista de la campaña (ver el comentario grande del
// encabezado de la migración 0019 sobre por qué no se recalcula después).
export async function crearCampana(
  p: ParamsCrearCampana,
  destinatarios: readonly Permitido<DestinatarioCampana>[],
  db: ClienteCampanas,
): Promise<ResultadoCrearCampana> {
  if (!p.asunto.trim()) return { ok: false, error: 'Falta el asunto.' };
  if (!p.html.trim()) return { ok: false, error: 'Falta el contenido del correo.' };
  if (destinatarios.length === 0) return { ok: false, error: 'No hay destinatarios para esta campaña.' };

  const { data: campana, error: errorCampana } = await db
    .from('campanas')
    .insert({
      zona: p.zona,
      plantilla: p.plantilla,
      asunto: p.asunto,
      preview_text: p.previewText ?? null,
      html: p.html,
      creado_por: p.creadoPor,
      programada: p.programada ?? false,
    })
    .select('id')
    .single();

  if (errorCampana || !campana?.id) {
    return { ok: false, error: `No se pudo crear la campaña: ${errorCampana?.message ?? 'sin id'}` };
  }

  // `upsert` con `ignoreDuplicates`, no `insert` a secas: la base importada
  // trae correos compartidos entre varios contactos (339 casos, ver
  // docs/ghl-base-comercial-2026.md -- sucursales de una misma cadena con
  // el mismo correo de facturación). Sin esto, dos destinatarios con el
  // mismo correo en la misma llamada violarían el índice único de la
  // migración 0019 y la campaña entera fallaría al crearse. Gana el
  // primero de la lista; el resto se descarta en silencio -- son la misma
  // bandeja de entrada de todos modos, así que no hay nada que perder.
  const filas = destinatarios.map((d) => ({
    campana_id: campana.id as string,
    correo: normalizarCorreo(d.correo),
    contacto_id: d.contactId,
    nombre_crm: d.nombreCrm,
  }));

  const { data: insertados, error: errorEnvios } = await db
    .from('campanas_envios')
    .upsert(filas, { onConflict: 'campana_id,correo', ignoreDuplicates: true })
    .select('id');

  if (errorEnvios) {
    return { ok: false, error: `No se pudo registrar la lista de destinatarios: ${errorEnvios.message}` };
  }

  return { ok: true, campanaId: campana.id as string, destinatarios: (insertados ?? []).length };
}

export type ResultadoCancelarCampana =
  | { ok: true; yaEstabaCancelada: boolean }
  | { ok: false; error: string; codigo?: 'no_existe' };

// Cancela una campaña -- lo que "cancelar", punto 1 del encargo, necesita
// del lado de escritura. Deliberadamente angosto: sólo marca `campanas`
// (`cancelada_at`/`cancelada_por`). NUNCA toca `campanas_envios` -- ni las
// filas 'pendiente' (se quedan 'pendiente' para siempre; ver el comentario
// grande de la migración 0020 sobre por qué), ni por supuesto las
// 'enviado'/'error' (lo ya mandado no se deshace ni se oculta, pedido
// explícito). Todo lo que hace falta para que "cancelada" de verdad frene
// tandas futuras vive en `enviarTanda` (el chequeo de abajo) y en el propio
// rpc `campanas_reclamar_pendientes` (migración 0020) -- acá sólo se
// escribe el hecho.
//
// Idempotente por diseño, mismo criterio que `registrarBaja`
// (lib/campanas/exclusiones.ts): cancelar una campaña ya cancelada no es un
// error -- devuelve `ok:true` con `yaEstabaCancelada:true` en vez de
// quejarse, porque dos superadmins que cancelan la misma campaña casi a la
// vez (o un doble clic) no tienen por qué ver un error por algo que de
// todas formas ya se cumplió.
export async function cancelarCampana(
  campanaId: string,
  canceladoPor: string,
  db: ClienteCampanas,
  ahora: () => Date = () => new Date(),
): Promise<ResultadoCancelarCampana> {
  const { data: campana, error: errorLeer } = await db
    .from('campanas')
    .select('id, cancelada_at')
    .eq('id', campanaId)
    .maybeSingle();
  if (errorLeer) return { ok: false, error: `No se pudo leer la campaña: ${errorLeer.message}` };
  if (!campana) return { ok: false, error: `No existe la campaña ${campanaId}.`, codigo: 'no_existe' };
  if (campana.cancelada_at) return { ok: true, yaEstabaCancelada: true };

  const { error: errorEscribir } = await db
    .from('campanas')
    .update({ cancelada_at: ahora().toISOString(), cancelada_por: canceladoPor })
    .eq('id', campanaId);
  if (errorEscribir) return { ok: false, error: `No se pudo cancelar la campaña: ${errorEscribir.message}` };

  return { ok: true, yaEstabaCancelada: false };
}

export type DepsEnvioCampana = {
  resendApiKey: string;
  remitente: string;
  fetchImpl?: typeof fetch;
  // Inyectable para poder probar qué reserva cuenta como "vencida" sin
  // depender del reloj real.
  ahora?: () => Date;
  // Envío programado (cron, lib/campanas/programado.ts): cuántos
  // destinatarios reclamar como máximo EN ESTA llamada -- por defecto
  // `TAMANO_TANDA` (100), el mismo valor de siempre, así que ninguna
  // llamada existente (la ruta /enviar, la de retomar desde Historial) se
  // entera de este campo ni cambia de comportamiento. El cron sí lo pasa:
  // durante la rampa (días 1 a 5) el cupo diario es menor a 100
  // (lib/campanas/programado.ts::topeParaDia), y `TAMANO_TANDA` fijo
  // mandaría de más el primer día. Nunca puede ser mayor a `TAMANO_TANDA`
  // -- ese es el máximo que acepta el endpoint de LOTE de Resend (ver el
  // comentario de `TAMANO_TANDA`) -- así que quien llame con un número más
  // grande igual queda acotado por Resend, no por esto.
  limiteTanda?: number;
};

export type ResultadoTanda =
  | {
      ok: true;
      procesados: number;
      enviados: number;
      fallidos: number;
      terminada: boolean;
      // Sólo presente (y en `true`) cuando esta llamada encontró la
      // campaña YA cancelada y por eso no reclamó nada -- `undefined` en
      // cualquier otro caso, a propósito: con `undefined` (no `false`),
      // `toEqual` en las pruebas existentes de este módulo (que no
      // conocían este campo) lo sigue tratando como ausente, así que no
      // hay que tocarlas. Ver el comentario grande, más abajo, sobre la
      // ventana angosta en la que una tanda puede terminar en `terminada:
      // true` sin este flag aunque la causa real haya sido una
      // cancelación -- documentado y aceptado, no un bug.
      cancelada?: true;
    }
  | { ok: false; error: string };

type FilaEnvio = { id: string; correo: string; nombre_crm: string };

// Hallazgo de producción (2026-09-18): del 10 al 18 de setiembre la zona
// Heredia / Norte GAM no mandó un solo correo en tres días hábiles.
// Resend rechazaba el LOTE ENTERO (67 direcciones) por UNA sola dirección
// mal digitada en el CRM -- jurodríduez@cafebritt.com, con una "í" (U+00ED)
// -- con este 422 medido contra la API real:
//   {"statusCode":422,"name":"validation_error","message":"Invalid `to`
//   field. The email address contains non-ASCII characters."}
// `enviarTanda` no marca ninguna fila ante un 4xx del LOTE (ver "SOBRE LOS
// FALLOS", más abajo) -- correcto para un fallo pasajero, pero un rechazo
// de VALIDACIÓN no es pasajero: el cron reclamaba, al día siguiente,
// exactamente el mismo lote, con la misma dirección mala adelante, y
// fallaba igual. Para siempre, en silencio.
//
// Esta función es la primera de las dos piezas del arreglo: valida CADA
// dirección, ANTES de armar el payload, contra la MISMA regla que Resend
// aplicó de verdad -- no ASCII en el campo `to`. Una dirección que la
// pase nunca entra a la petición: se cierra sola, como 'error', con el
// motivo escrito en su columna -- y el resto de la tanda (los otros 66)
// sale por Resend sin enterarse. Devuelve el motivo (para escribirlo tal
// cual en `campanas_envios.error`) o `null` si la dirección pasa.
//
// Deliberadamente angosta -- sólo la regla que de verdad causó el
// incidente medido, no un validador de correos genérico (RFC 5322 completo
// es mucho más de lo que hace falta acá, y un formato "raro" pero ASCII
// que Resend sí aceptaría no tiene por qué rechazarse antes de intentarlo).
export function direccionInvalidaParaResend(correo: string): string | null {
  if (/[^\x00-\x7F]/.test(correo)) {
    return 'Resend rechaza esta dirección: tiene caracteres no ASCII (por ejemplo, una tilde o una ñ).';
  }
  return null;
}

// La segunda pieza del arreglo: cuando Resend SÍ rechaza el lote entero
// (después de filtrar las direcciones que ya se sabía que iba a rechazar,
// arriba), hay que decidir si vale la pena dejarlo 'pendiente' para que
// `campanas_reclamar_pendientes` lo retome solo, o si insistir es inútil.
//
// EL CRITERIO, con la evidencia medida de este mismo incidente: Resend
// documenta un campo `name` en el cuerpo del error que dice POR QUÉ
// rechazó la petición. `"validation_error"` (siempre con estado HTTP 422)
// significa, letra por letra, que el CONTENIDO de la petición no cumple lo
// que Resend exige -- mandar exactamente el mismo cuerpo otra vez produce,
// siempre, el mismo rechazo. Eso es, precisamente, la definición de "no se
// arregla insistiendo": PERMANENTE para este lote.
//
// Por qué NO "cualquier 4xx es permanente" -- la trampa más fácil acá:
// 401/403 (llave de Resend vencida, mal configurada, o revocada) y 429
// (límite de tasa) también son 4xx, pero NINGUNO de los dos es un problema
// del CONTENIDO de esta tanda en particular -- una llave que se renueva, o
// una ventana de límite que pasa, hace que el MISMO payload sí pase la
// próxima vez. Tratarlos como permanentes marcaría 'error', para siempre,
// a decenas de direcciones perfectamente buenas por un problema de
// configuración o de tráfico que no tiene nada que ver con ellas -- el
// mismo tipo de daño colateral que el defecto 1 (arriba) evita para una
// sola dirección mala, pero aplicado, esta vez, a los 67 destinatarios
// enteros. Por eso el criterio es angosto a propósito: SÓLO 422 con
// `name === 'validation_error'`, nada más.
export function esFalloPermanenteDeLote(status: number, cuerpo: unknown): boolean {
  if (status !== 422) return false;
  const nombre = (cuerpo as { name?: unknown } | null)?.name;
  return nombre === 'validation_error';
}

// Cierra (RPC `campanas_cerrar_tanda`) los resultados que haya que cerrar
// en esta llamada -- que pueden ser un subconjunto de la tanda reclamada
// (sólo las direcciones inválidas, si Resend todavía no respondió nada) o
// la tanda entera. Un arreglo vacío no llama al rpc para nada -- es
// EXACTAMENTE lo que mantiene intacta la garantía de "SOBRE LOS FALLOS":
// un fallo de la llamada entera a Resend (red caída, 4xx/5xx pasajero)
// sigue sin marcar ninguna fila cuando no había ninguna dirección inválida
// de por medio.
type CambioFila = {
  id: string;
  estado: 'enviado' | 'error';
  resend_id: string | null;
  error: string | null;
  actualizado_at: string;
};

async function cerrarTanda(db: ClienteCampanas, campanaId: string, cambios: CambioFila[]): Promise<void> {
  if (cambios.length === 0) return;
  const { error: errorCierre } = await db.rpc(RPC_CERRAR_TANDA, { p_resultados: cambios });
  if (errorCierre) {
    // Ventana angosta y aceptada -- ver el comentario grande de
    // `enviarTanda` sobre por qué esto no se reintenta desde acá.
    console.error('[campanas] No se pudo cerrar la tanda.', campanaId, errorCierre.message);
  }
}

// Manda UNA tanda (hasta `TAMANO_TANDA` destinatarios) de una campaña ya
// creada, y devuelve un resumen. Se llama repetidas veces -- desde la
// pantalla (parte 2), un botón "continuar" o un intervalo -- hasta que
// `terminada` da `true`. Cada llamada es independiente y retomable: no
// hace falta pasarle ningún cursor ni recordar dónde quedó la anterior,
// porque eso vive en `campanas_envios` (migración 0019).
//
// SOBRE LOS FALLOS -- la distinción que sostiene todo el diseño:
//   - Una dirección que Resend YA SE SABE que va a rechazar (hallazgo de
//     producción, 2026-09-18: `direccionInvalidaParaResend`, arriba) nunca
//     llega a la petición -- se cierra sola, como 'error', ANTES de armar
//     el payload. Es lo que evita que una sola dirección mala envenene a
//     los demás destinatarios de la misma tanda.
//   - Un fallo de la LLAMADA A RESEND ENTERA (red caída, un 4xx/5xx
//     PASAJERO, JSON ilegible): no se marca NINGUNA de las filas que sí se
//     mandaron a intentar. Se asume que, si la petición no terminó en un
//     2xx, Resend no aceptó ningún correo de esta tanda -- así que no hay
//     nada que deshacer, sólo dejar la reserva ('pendiente', con
//     `actualizado_at` reciente) donde estaba. Pasados
//     `MINUTOS_RESERVA_VENCIDA`, `campanas_reclamar_pendientes` la vuelve a
//     entregar sola, en una tanda futura. Así es como "un fallo de Resend"
//     queda retomable sin ningún código especial para ese caso -- es el
//     MISMO mecanismo que recupera una tanda cortada a mitad de camino por
//     cualquier otro motivo (el servidor se corta, la pestaña se cierra):
//     ambos dejan la fila 'pendiente' con una reserva que, tarde o
//     temprano, vence.
//   - Un fallo de la LLAMADA A RESEND ENTERA que es PERMANENTE (hallazgo de
//     producción, 2026-09-18: `esFalloPermanenteDeLote`, arriba -- un 422
//     `validation_error`): insistir con el MISMO payload produce, siempre,
//     el mismo rechazo -- dejarlo 'pendiente' es el bucle infinito y mudo
//     que trancó Heredia / Norte GAM tres días. Acá SÍ se marcan todas las
//     filas de la tanda como 'error' (con el mensaje de Resend), lo que
//     libera la reserva -- la zona sigue adelante mañana -- y queda visible
//     en el historial como destinatarios "con error", en vez de perderse
//     en un limbo silencioso.
//   - Un fallo de UN destinatario dentro de una llamada que SÍ tuvo éxito
//     (Resend contestó 2xx pero no confirmó un id para ese ítem en
//     particular): esa fila SÍ se marca 'error', de forma permanente. No
//     se reintenta sola -- el resto de la tanda ya se dio por enviada, y
//     reintentar automáticamente sólo a éste podría mandarlo dos veces si
//     el problema fue de lectura de la respuesta y no de que Resend lo
//     haya rechazado de verdad. "Un fallo de un destinatario no tumba la
//     tanda: se registra y se sigue" -- el resto de `enviados` sigue su
//     curso normal.
// Cerrar lo que corresponda de la tanda -- marcar el resultado de hasta
// cien destinatarios -- es siempre, en cualquiera de las ramas de arriba,
// UNA sola llamada (`cerrarTanda`, que envuelve el rpc `campanas_cerrar_tanda`
// de la migración 0023), no cien peticiones sueltas que puedan cortarse a
// la mitad: ver el comentario grande junto a esa función, más arriba, sobre
// la garantía exacta que resuelve (hallazgo importante de la revisión
// final, punto 1).
export async function enviarTanda(
  campanaId: string,
  deps: DepsEnvioCampana,
  db: ClienteCampanas,
): Promise<ResultadoTanda> {
  const { resendApiKey, remitente, fetchImpl = fetch, ahora = () => new Date(), limiteTanda } = deps;
  // Acotado a `[1, TAMANO_TANDA]` -- nunca 0 ni negativo (eso reclamaría
  // nada, distinto de "no había pendientes"), y nunca por encima de lo que
  // Resend acepta en un solo lote.
  const limite =
    limiteTanda === undefined ? TAMANO_TANDA : Math.max(1, Math.min(TAMANO_TANDA, Math.trunc(limiteTanda)));

  if (!resendApiKey) return { ok: false, error: 'Falta RESEND_API_KEY: no se pudo enviar.' };
  if (!remitente) return { ok: false, error: 'Falta el remitente: no se pudo enviar.' };

  const { data: campana, error: errorCampana } = await db
    .from('campanas')
    .select('asunto, html, preview_text, cancelada_at')
    .eq('id', campanaId)
    .maybeSingle();
  if (errorCampana) return { ok: false, error: `No se pudo leer la campaña: ${errorCampana.message}` };
  if (!campana) return { ok: false, error: `No existe la campaña ${campanaId}.` };

  // Cancelada ANTES de intentar reclamar nada: ni siquiera se llama al rpc.
  // Cubre el caso común (alguien cancela, y la próxima tanda -- del mismo
  // "retomar" en curso, o de una sesión que vuelve más tarde -- ve esto y
  // se detiene sola). El caso menos común -- la cancelación se escribe
  // justo ENTRE esta lectura y el rpc de abajo -- lo cubre el propio rpc
  // `campanas_reclamar_pendientes` (migración 0020), que repite este mismo
  // filtro dentro de su única sentencia atómica: en esa ventana angosta,
  // `filas.length === 0` más abajo sigue impidiendo que se llame a Resend,
  // sólo que esta llamada en particular vuelve con `terminada: true` sin
  // `cancelada: true` (no se vuelve a leer `cancelada_at` sólo para afinar
  // un mensaje) -- de todas formas no sale ningún correo de más, que es la
  // garantía que importa.
  if (campana.cancelada_at) {
    return { ok: true, procesados: 0, enviados: 0, fallidos: 0, terminada: true, cancelada: true };
  }

  const vencidoDesde = new Date(ahora().getTime() - MINUTOS_RESERVA_VENCIDA * 60_000).toISOString();

  const { data: reservados, error: errorReclamo } = await db.rpc(RPC_RECLAMAR, {
    p_campana_id: campanaId,
    p_limite: limite,
    p_vencido_desde: vencidoDesde,
  });
  if (errorReclamo) return { ok: false, error: `No se pudo reservar la tanda: ${errorReclamo.message}` };

  const filas = (reservados ?? []) as FilaEnvio[];
  if (filas.length === 0) {
    return { ok: true, procesados: 0, enviados: 0, fallidos: 0, terminada: true };
  }

  // Defecto 1 -- separar, ANTES de armar el payload, las direcciones que
  // Resend YA SE SABE que va a rechazar. Ver `direccionInvalidaParaResend`,
  // más arriba, para el porqué exacto (jurodríduez@cafebritt.com).
  const filasInvalidas: Array<{ fila: FilaEnvio; motivo: string }> = [];
  const filasValidas: FilaEnvio[] = [];
  for (const f of filas) {
    const motivo = direccionInvalidaParaResend(f.correo);
    if (motivo) filasInvalidas.push({ fila: f, motivo });
    else filasValidas.push(f);
  }

  const ahoraCierre = new Date().toISOString();
  const cambiosInvalidos: CambioFila[] = filasInvalidas.map(({ fila, motivo }) => ({
    id: fila.id,
    estado: 'error',
    resend_id: null,
    error: motivo,
    actualizado_at: ahoraCierre,
  }));

  // Todo lo reclamado era inválido -- no hay nada que mandarle a Resend.
  // Se cierran las inválidas (una sola llamada) y se devuelve sin tocar la
  // red: exactamente el caso de "todas las direcciones invalidas" que le
  // pasaría a una zona cuyo único pendiente fuera la fila mala.
  if (filasValidas.length === 0) {
    await cerrarTanda(db, campanaId, cambiosInvalidos);
    return {
      ok: true,
      procesados: filas.length,
      enviados: 0,
      fallidos: cambiosInvalidos.length,
      terminada: filas.length < limite,
    };
  }

  // Menor (revisión final): `preview_text` no varía por destinatario --
  // igual que `asunto` -- así que se resuelve UNA sola vez acá, no dentro
  // del `.map` de abajo. Ver el comentario grande de `inyectarVistaPrevia`
  // (lib/campanas/marcadores.ts) sobre por qué es seguro inyectarla siempre
  // (no duplica nada en las cuatro plantillas fijas, que ya la traen
  // horneada).
  const htmlConVistaPrevia = inyectarVistaPrevia(campana.html as string, campana.preview_text as string | null);

  // El payload sale de `filasValidas`, NUNCA de `filas` -- es lo que evita
  // que una dirección inválida viaje adentro de la petición y tumbe la
  // tanda entera.
  const payload = filasValidas.map((f) => ({
    from: remitente,
    to: [f.correo],
    subject: campana.asunto as string,
    html: renderizarPlantilla(htmlConVistaPrevia, {
      nombreCrm: f.nombre_crm,
      unsubscribeUrl: enlacePaginaBaja(f.correo),
    }),
    headers: cabecerasListaBaja(f.correo),
  }));

  let res: Response;
  try {
    res = await fetchImpl(RESEND_BATCH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // No se toca ninguna fila VÁLIDA -- ver "SOBRE LOS FALLOS", más arriba.
    // Un error de red se retoma solo. Las inválidas SÍ se cierran: no
    // dependen de la red, ya se sabía que Resend las iba a rechazar.
    await cerrarTanda(db, campanaId, cambiosInvalidos);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const texto = await res.text();
  if (!res.ok) {
    // Defecto 2 -- permanente vs pasajero. Ver `esFalloPermanenteDeLote`,
    // más arriba, para el criterio completo y por qué.
    let cuerpoError: unknown = null;
    try {
      cuerpoError = JSON.parse(texto);
    } catch {
      // Sin JSON no hay forma de confirmar el motivo -- se trata como
      // pasajero (la rama de abajo).
    }

    if (esFalloPermanenteDeLote(res.status, cuerpoError)) {
      // El mismo payload va a fallar SIEMPRE de la misma forma -- insistir
      // no lo arregla. Se cierra la tanda ENTERA (inválidas + válidas) como
      // 'error', lo que libera la reserva para siempre en vez de trancarla
      // -- y queda visible en el historial, en vez del bucle mudo de hoy.
      const mensaje = `Resend rechazó el lote entero: ${texto.slice(0, 300)}`;
      const cambios = cambiosInvalidos.concat(
        filasValidas.map((f) => ({
          id: f.id,
          estado: 'error' as const,
          resend_id: null,
          error: mensaje,
          actualizado_at: ahoraCierre,
        })),
      );
      await cerrarTanda(db, campanaId, cambios);
      return {
        ok: true,
        procesados: filas.length,
        enviados: 0,
        fallidos: cambios.length,
        terminada: filas.length < limite,
      };
    }

    // Pasajero (401/403/429/5xx, u otro 422 sin `name: 'validation_error'`):
    // mismo criterio de siempre -- las válidas se dejan 'pendiente' para
    // que se retomen solas. Las inválidas SÍ se cierran.
    await cerrarTanda(db, campanaId, cambiosInvalidos);
    return { ok: false, error: `Resend ${res.status}: ${texto.slice(0, 300)}` };
  }

  let datos: { data?: { id?: string }[] };
  try {
    datos = JSON.parse(texto);
  } catch {
    await cerrarTanda(db, campanaId, cambiosInvalidos);
    return { ok: false, error: `Resend respondió con JSON ilegible: ${texto.slice(0, 200)}` };
  }

  const resultados = datos.data ?? [];
  let enviados = 0;
  let fallidos = cambiosInvalidos.length;

  // Hallazgo importante (revisión final, punto 1): esto ANTES era hasta
  // CIEN `.update().eq('id', ...)` sueltos, uno por destinatario, todos en
  // paralelo con `Promise.all` -- cien viajes HTTP independientes a
  // Supabase. Si la función se cortaba a mitad de esos cien, las filas que
  // no alcanzaron a marcarse quedaban 'pendiente' con la reserva vieja, y
  // `campanas_reclamar_pendientes` las volvía a entregar solas pasados
  // `MINUTOS_RESERVA_VENCIDA` -- pero Resend YA les había mandado el correo
  // (el lote entero se aceptó en una única llamada, arriba): ese
  // destinatario recibía el mismo correo dos veces. El índice único de la
  // migración 0019 y el `skip locked` de `campanas_reclamar_pendientes` NO
  // cubrían esto -- los dos evitan que DOS TANDAS le manden a la MISMA
  // fila, ninguno evita que una fila YA MANDADA se vuelva a ofrecer porque
  // nadie alcanzó a cerrarla.
  //
  // LA GARANTÍA ELEGIDA: cerrar la tanda entera es UNA sola llamada al rpc
  // `campanas_cerrar_tanda` (migración 0023), que hace el `update` de las
  // hasta cien filas en una única sentencia SQL -- dentro de una única
  // transacción de Postgres: o se aplica ENTERA, o (si la conexión se
  // corta a mitad de esta llamada) no se aplica NADA de ella. No queda un
  // estado a medias ("50 de 100 marcadas") como sí podía quedar antes. Es
  // el mismo principio que ya sostiene `campanas_reclamar_pendientes` para
  // ABRIR la tanda (una sola sentencia atómica, no "leer, decidir,
  // escribir" repartido en la aplicación) -- acá se aplica al otro
  // extremo, cerrarla.
  //
  // Lo que esto NO elimina -- aceptado, y ya era un riesgo antes de este
  // arreglo: si la conexión se corta ENTRE que Resend aceptó el lote y que
  // este rpc corre, ninguna fila se cierra y las cien se vuelven a ofrecer
  // solas. La diferencia es que antes había CIEN puntos de falla
  // independientes (y un corte a mitad garantizaba un resultado a medias);
  // ahora hay UNO solo, y si falla, falla entero -- sin duplicados
  // parciales. Cerrar del todo ese riesgo exigiría una clave de
  // idempotencia del lado de Resend, que la API de lote no ofrece hoy --
  // fuera del alcance de este arreglo.
  const cambiosValidos: CambioFila[] = filasValidas.map((f, i) => {
    const resendId = resultados[i]?.id;
    if (resendId) {
      enviados++;
      return { id: f.id, estado: 'enviado', resend_id: resendId, error: null, actualizado_at: ahoraCierre };
    }
    fallidos++;
    return {
      id: f.id,
      estado: 'error',
      resend_id: null,
      error: 'Resend no confirmó el envío para este destinatario.',
      actualizado_at: ahoraCierre,
    };
  });

  await cerrarTanda(db, campanaId, cambiosInvalidos.concat(cambiosValidos));

  return {
    ok: true,
    procesados: filas.length,
    enviados,
    fallidos,
    // Menos de una tanda completa reclamada sólo puede pasar cuando ya no
    // quedaba más para reclamar en este momento -- `campanas_reclamar_pendientes`
    // siempre intenta llevarse hasta `limite` (por defecto `TAMANO_TANDA`,
    // salvo que el cron pida menos -- ver el comentario de `limiteTanda`
    // más arriba). Con un `limite` acotado por el cupo diario del cron,
    // esto puede dar `false` aunque la campaña ya no tenga MÁS pendientes
    // que los que trajo esta tanda -- no es un error: sólo dice "esta
    // llamada no agotó el límite que traía", que es la pregunta que le
    // importa a quien la llamó.
    terminada: filas.length < limite,
  };
}
