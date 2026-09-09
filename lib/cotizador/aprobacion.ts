// Descuento personalizado con aprobación (fase 5, diseño en
// docs/superpowers/specs/2026-09-02-descuento-aprobacion-design.md). Este
// módulo es el corazón del flujo posterior a "pedir la aprobación" (eso
// vive en app/api/cotizacion/route.ts, porque nace en el mismo momento que
// la cotización): listar lo pendiente, aprobar (tal cual o con el
// porcentaje cambiado) y rechazar. Las tres rutas de
// app/api/cotizacion/{pendientes,aprobar,rechazar}/route.ts son delgadas a
// propósito -- auth, CSRF, parseo -- y delegan la lógica acá, mismo criterio
// que lib/cotizador/equipo.ts con las cuatro rutas de app/api/equipo/*.
import 'server-only';
import { calcular } from '@/lib/cotizador/calcular';
import { CATALOGO } from '@/lib/cotizador/catalogo';
import { enviarCotizacionAlHotel } from '@/lib/cotizador/enviar';
import { enviarSolicitudAprobacion, enviarResolucionAprobacion } from '@/lib/cotizador/correo-aprobacion';
import type { DepsCorreo, ResultadoCorreo } from '@/lib/cotizador/correo';
import type { DescuentoPersonalizado, GrupoDescuento, Sku } from '@/lib/cotizador/tipos';

// Mismo tipo laxo que `Db` en lib/cotizador/equipo.ts: permite probar la
// lógica sin un cliente real de Supabase. No necesita `rpc` -- a diferencia
// del equipo, acá no hay una carrera de "última persona activa" que
// justifique una función de Postgres; el compare-and-swap de más abajo
// alcanza con `update().eq(...).select()`.
export type Db = { from: (tabla: string) => any };

// Mismo texto en las tres rutas de este flujo, igual que `SIN_PERMISO` en
// lib/cotizador/equipo.ts para las de /api/equipo/*: quien no es superadmin
// (releído de la base, nunca del rol de la cookie) recibe siempre este
// mensaje.
export const SIN_PERMISO_APROBAR = 'No tenés permiso para aprobar descuentos.';

const ESTADO_PENDIENTE = 'esperando_aprobacion';

// Estado transitorio que usa `aprobar` para reclamar la fila antes de
// mandarla por el mismo camino de envío que una cotización recién creada
// (ver el comentario grande junto al compare-and-swap, más abajo). No es un
// estado nuevo: es el mismo 'borrador' en el que nace toda cotización antes
// de que `enviarCotizacionAlHotel` la deje en 'enviada' o 'error' -- mismo
// riesgo ya aceptado de huérfano si la función se cuelga a mitad (ver el
// comentario de `maxDuration` en app/api/cotizacion/route.ts), no uno nuevo.
const ESTADO_RECLAMADO = 'borrador';

export type ClienteCotizacion = { nombre: string; empresa?: string; email: string };

// Compara dos `DescuentoPersonalizado` por valor, no por referencia -- es
// lo que separa "el superadmin aprobó tal cual" de "el superadmin cambió el
// porcentaje" (el dato que el correo de resolución tiene que destacar). Las
// dos formas son estructuralmente distintas (`general` vs `familias`): si
// cambian de forma entre lo pedido y lo aprobado, ya es un cambio, sin
// necesidad de mirar más.
export function descuentosIguales(a: DescuentoPersonalizado, b: DescuentoPersonalizado): boolean {
  const aGeneral = 'general' in a;
  const bGeneral = 'general' in b;
  if (aGeneral !== bGeneral) return false;

  if (aGeneral) {
    return (a as { general: number }).general === (b as { general: number }).general;
  }

  const fa = (a as { familias: Partial<Record<string, number>> }).familias;
  const fb = (b as { familias: Partial<Record<string, number>> }).familias;
  const clavesA = Object.keys(fa).sort();
  const clavesB = Object.keys(fb).sort();
  if (clavesA.length !== clavesB.length) return false;
  return clavesA.every((clave, i) => clave === clavesB[i] && fa[clave] === fb[clave]);
}

// I3 (revision-final-2.md): antes bastaba `skuId`/`cantidad` porque
// `aprobar()` recalculaba contra `CATALOGO` (el catálogo de HOY). Ahora la
// fila es la ÚNICA fuente del precio (ver `catalogoCongelado`, más abajo),
// así que esta línea tiene que llevar todo lo que `calcular`
// (lib/cotizador/calcular.ts) ya guardó en el insert -- las mismas piezas
// de `Sku` de las que depende el cálculo: `precioLista`, `grupo`, `nombre`
// y `contenido`. No `familia`/`linea`: `calcular` nunca los lee, y
// `LineaCalculada` (lo que de verdad queda en la columna) tampoco los trae.
type LineaFilaGuardada = {
  skuId: string;
  cantidad: number;
  precioLista: number;
  grupo: GrupoDescuento;
  nombre: string;
  contenido?: string[];
};

// I3 (revision-final-2.md): reconstruye el catálogo tal como estaba cuando
// se guardó la fila -- el mismo precio que el superadmin miró en la
// tarjeta de /pendientes -- a partir de lo que YA quedó escrito en
// `lineas`. Nunca contra `CATALOGO` (el de HOY): la lista de precios puede
// regenerarse y desplegarse en los días que una solicitud pasa esperando,
// y `aprobar()` no puede dejar que ese cambio se cuele en silencio en un
// PDF que el superadmin nunca vio.
//
// `linea`/`familia` van con un valor fijo -- no participan del cálculo
// (`calcular` sólo lee `id`, `grupo`, `precioLista`, `nombre`, `contenido`)
// así que alcanza con satisfacer el tipo `Sku`; no se filtran a ningún
// lado, porque `LineaCalculada` (lo que `calcular` devuelve) no los lleva.
function catalogoCongelado(lineas: LineaFilaGuardada[]): Sku[] {
  return lineas.map((l) => ({
    id: l.skuId,
    linea: 'uniformes',
    grupo: l.grupo,
    familia: '',
    nombre: l.nombre,
    precioLista: l.precioLista,
    contenido: l.contenido,
  }));
}

// I3 (revision-final-2.md): lo que le avisa al superadmin, en la tarjeta,
// que el precio que está mirando ya no es el de hoy -- antes de que
// decida. `aprobar()` va a usar SIEMPRE el precio congelado en la fila (ver
// `catalogoCongelado`), así que esto no cambia lo que se manda al hotel;
// sólo hace visible que la lista de precios cambió, para que el superadmin
// pueda decidir con esa información -- aprobar con el precio viejo, tal
// como se pidió, o rechazar la solicitud para que el vendedor la rehaga
// contra la lista nueva. Un SKU que ya no existe en el catálogo de hoy
// (se descontinuó) también cuenta como "desactualizado": no hay ningún
// precio vigente con el que compararlo, y eso es justo la clase de cambio
// que el superadmin necesita ver.
function precioListaDesactualizado(lineas: LineaFilaGuardada[]): boolean {
  const vigentePorId = new Map(CATALOGO.map((s) => [s.id, s.precioLista]));
  return lineas.some((l) => vigentePorId.get(l.skuId) !== l.precioLista);
}

// La fila tal como la necesita este módulo -- ni la forma completa de la
// tabla (`vendedor`, `pdf_ruta`, etc. no hacen falta acá) ni la recortada de
// /listado (que a propósito no trae `lineas`, y acá sí hacen falta para
// recalcular si el porcentaje cambia).
//
// `totales` lleva la forma COMPLETA (no sólo `tasaIva`/`bordadoEspecial`,
// las dos que `calcular` necesita como opciones) porque, además de eso, este
// módulo la usa para dos cosas más: guardar el total que de verdad se
// recalculó (ver el comentario grande junto al compare-and-swap, más abajo)
// y devolverle a la fila su valor pedido original si el envío revienta a
// mitad de camino y hay que liberar la reclamación.
type FilaPendiente = {
  id: string;
  estado: string;
  numero: string;
  cliente: ClienteCotizacion;
  lineas: LineaFilaGuardada[];
  totales: { subtotal: number; ahorro: number; tasaIva: number; iva: number; total: number; bordadoEspecial: boolean };
  descuento_personalizado: DescuentoPersonalizado;
  solicitado_por: string | null;
  contact_id: string | null;
  reemplaza_a: string | null;
};

const COLUMNAS_PENDIENTE =
  'id, estado, numero, created_at, cliente, lineas, totales, descuento_personalizado, ' +
  'solicitado_por, vendedor, contact_id, reemplaza_a, reemplaza_a_numero';

export type FilaListado = {
  id: string;
  numero: string;
  created_at: string;
  cliente: ClienteCotizacion;
  lineas: LineaFilaGuardada[];
  totales: { total: number; subtotal: number; iva: number; tasaIva: number; bordadoEspecial: boolean };
  descuento_personalizado: DescuentoPersonalizado;
  solicitado_por: string | null;
  vendedor: string | null;
  contact_id: string | null;
  reemplaza_a: string | null;
  reemplaza_a_numero: string | null;
  // I3 (revision-final-2.md): true cuando algún `precioLista` congelado en
  // `lineas` ya no coincide con el del catálogo de hoy (o el SKU se
  // descontinuó). Calculado en `listarPendientes`, no acá -- ver
  // `precioListaDesactualizado`.
  precioListaDesactualizado: boolean;
};

// La cola completa de lo que espera un superadmin -- todas las filas en
// 'esperando_aprobacion', la más vieja primero: es lo que hace visible
// "cuánto lleva esperando" (diseño, sección de riesgos) sin que la pantalla
// tenga que ordenar nada por su cuenta.
export async function listarPendientes(
  db: Db,
): Promise<{ ok: true; cotizaciones: FilaListado[] } | { ok: false; error: string }> {
  const { data, error } = await db
    .from('cotizaciones')
    .select(COLUMNAS_PENDIENTE)
    .eq('estado', ESTADO_PENDIENTE)
    .order('created_at', { ascending: true });

  if (error) return { ok: false, error: error.message };

  // I3 (revision-final-2.md): se calcula acá, no en `aprobar()` -- el
  // superadmin tiene que verlo ANTES de decidir, en la tarjeta de
  // /pendientes, no enterarse después de que ya aprobó.
  const filas = (data ?? []) as Array<Omit<FilaListado, 'precioListaDesactualizado'>>;
  const cotizaciones: FilaListado[] = filas.map((f) => ({
    ...f,
    precioListaDesactualizado: precioListaDesactualizado(f.lineas),
  }));

  return { ok: true, cotizaciones };
}

// Busca el correo de una persona del equipo por su NOMBRE -- el mismo dato
// que guarda `solicitado_por`/`vendedor` (Tarea 6, y ronda de correcciones
// de aprobación): esta fila tiene que seguir diciendo quién pidió el
// descuento aunque esa persona se haya dado de baja, así que no hay ningún
// id a mano para buscarla. `invitarPersona` (lib/cotizador/equipo.ts)
// rechaza nombres repetidos en el equipo desde la Tarea 5, así que un
// nombre exacto identifica a lo sumo a una persona activa; si no aparece
// ninguna (se dio de baja, o el nombre no calza) el aviso simplemente no
// sale -- mejor esfuerzo, igual que el resto de los correos de este flujo.
async function correoDePersona(db: Db, nombre: string | null): Promise<string | null> {
  if (!nombre) return null;
  const { data, error } = await db.from('usuarios_panel').select('correo').eq('nombre', nombre).maybeSingle();
  if (error || !data) return null;
  return (data as { correo: string }).correo;
}

// Todos los superadmin ACTIVOS -- una persona desactivada no debe seguir
// recibiendo estos avisos aunque conserve el rol en la fila.
async function correosSuperadminActivos(db: Db): Promise<string[]> {
  const { data, error } = await db.from('usuarios_panel').select('correo').eq('rol', 'superadmin').eq('activo', true);
  if (error) {
    console.error('[cotizador] No se pudo leer la lista de superadmin activos.', error.message);
    return [];
  }
  return ((data ?? []) as Array<{ correo: string }>).map((f) => f.correo);
}

export type ParamsAvisoSolicitud = {
  numero: string;
  cliente: ClienteCotizacion;
  total: number;
  descuentoPedido: DescuentoPersonalizado;
  solicitadoPor: string;
};

// Se llama desde app/api/cotizacion/route.ts justo después de guardar una
// cotización en 'esperando_aprobacion'. Nunca lanza: un fallo acá no debe
// tumbar una petición cuya cotización ya quedó guardada -- mismo criterio
// que el resto de los correos del panel (ver `correo_error` en
// app/api/cotizacion/route.ts).
export async function avisarSolicitudAprobacion(
  db: Db,
  deps: DepsCorreo,
  params: ParamsAvisoSolicitud,
): Promise<ResultadoCorreo> {
  const correos = await correosSuperadminActivos(db);
  if (correos.length === 0) {
    console.error(
      '[cotizador] Hay una cotización esperando aprobación pero no hay ningún superadmin activo a quien avisar.',
      params.numero,
    );
    return { ok: false, error: 'No hay ningún superadmin activo a quien avisar.' };
  }
  return enviarSolicitudAprobacion({ para: correos, ...params }, deps);
}

async function avisarResolucion(
  db: Db,
  deps: DepsCorreo,
  params: {
    nombreVendedor: string | null;
    numero: string;
    cliente: ClienteCotizacion;
    resultado: 'aprobada' | 'rechazada';
    descuentoPedido: DescuentoPersonalizado;
    descuentoAprobado?: DescuentoPersonalizado;
    cambioPorcentaje: boolean;
    motivoRechazo?: string;
    resueltoPor: string;
    // I4 (revision-final-2.md): sólo importa cuando `resultado === 'aprobada'`
    // -- ver el comentario del mismo nombre en correo-aprobacion.ts.
    correoHotelOk: boolean;
  },
): Promise<ResultadoCorreo> {
  const correo = await correoDePersona(db, params.nombreVendedor);
  if (!correo) {
    console.error(
      '[cotizador] No se pudo avisar el desenlace de la aprobación: no se encontró el correo de quien la pidió.',
      params.nombreVendedor,
    );
    return { ok: false, error: 'No se encontró el correo de quien pidió la cotización.' };
  }
  const { nombreVendedor: _nombreVendedor, ...resto } = params;
  return enviarResolucionAprobacion({ para: correo, ...resto }, deps);
}

export type ResultadoAprobar =
  | {
      ok: true;
      numero: string;
      estadoFinal: 'enviada' | 'error';
      cambioPorcentaje: boolean;
      avisoEnviado: boolean;
    }
  | { ok: false; motivo: 'no_encontrado' }
  | { ok: false; motivo: 'no_pendiente'; estadoActual: string }
  | { ok: false; motivo: 'error'; error: string };

export type ParamsAprobar = {
  id: string;
  aprobador: string;
  // Si el superadmin cambia el porcentaje antes de aprobar. `undefined`
  // significa "tal cual se pidió".
  nuevoDescuento?: DescuentoPersonalizado;
};

// Aprobar es el único de los tres caminos de este módulo que hace trabajo
// pesado: recalcula la cotización (por si el porcentaje cambió) y corre por
// el mismo `enviarCotizacionAlHotel` que hoy usa la creación directa --
// Estimate y Opportunity en GoHighLevel, PDF, correo con el adjunto, nota,
// y (si venía de "Modificar") marcar la vieja como reemplazada.
export async function aprobar(
  db: Db,
  deps: DepsCorreo,
  params: ParamsAprobar,
): Promise<ResultadoAprobar> {
  const { data, error } = await db
    .from('cotizaciones')
    .select(COLUMNAS_PENDIENTE)
    .eq('id', params.id)
    .maybeSingle();

  if (error) {
    console.error('[cotizador] No se pudo consultar la cotización a aprobar.', error.message);
    return { ok: false, motivo: 'error', error: error.message };
  }
  if (!data) return { ok: false, motivo: 'no_encontrado' };

  const fila = data as FilaPendiente;

  // No alcanza con confiar en lo que manda el navegador: se comprueba acá,
  // sobre la relectura fresca, que la fila de verdad sigue esperando.
  if (fila.estado !== ESTADO_PENDIENTE) {
    return { ok: false, motivo: 'no_pendiente', estadoActual: fila.estado };
  }

  const descuentoFinal = params.nuevoDescuento ?? fila.descuento_personalizado;
  const cambioPorcentaje = !descuentosIguales(descuentoFinal, fila.descuento_personalizado);

  // I3 (revision-final-2.md): `catalogoCongelado(fila.lineas)`, NUNCA
  // `CATALOGO` -- ver el comentario grande junto a esa función. Antes de
  // este arreglo, acá iba `CATALOGO` (el catálogo de HOY): si la lista de
  // precios se regeneraba y desplegaba mientras la solicitud esperaba
  // (días, no segundos -- el uso normal de este flujo), el PDF y el
  // Estimate de GoHighLevel salían con precios que el superadmin nunca vio
  // en la tarjeta que aprobó, y como el PORCENTAJE no había cambiado, el
  // correo de resolución igual decía "se aprobó tal cual lo pediste" --
  // nadie se enteraba. Ahora el precio que ve el superadmin en /pendientes
  // (`fila.totales.total`, calculado con estos mismos `lineas` en el
  // insert) es el mismo que sale al hotel, cambie el porcentaje o no.
  let cotizacion;
  try {
    cotizacion = calcular(
      fila.lineas.map((l) => ({ skuId: l.skuId, cantidad: l.cantidad })),
      catalogoCongelado(fila.lineas),
      {
        tasaIva: fila.totales.tasaIva,
        bordadoEspecial: fila.totales.bordadoEspecial,
        descuentoPersonalizado: descuentoFinal,
      },
    );
  } catch (err) {
    return { ok: false, motivo: 'error', error: err instanceof Error ? err.message : 'No se pudo recalcular.' };
  }

  // El compare-and-swap: reclama la fila SÓLO si sigue en
  // 'esperando_aprobacion' en este instante -- no en el de la lectura de
  // arriba. El filtro va sobre `estado`, no sobre un campo aparte, a
  // propósito: es lo único que impide que dos superadmin aprobando la misma
  // fila casi al mismo tiempo (o uno aprobando mientras otro la rechaza)
  // corran las dos el envío pesado de abajo. `rechazar`, más abajo, hace el
  // mismo `.eq('estado', ESTADO_PENDIENTE)` en su propio update -- cualquiera
  // de los dos que gane la carrera dejará al otro sin filas que tocar.
  //
  // Hallazgo crítico (revisión final): antes de esto, ESTE update nunca
  // tocaba `lineas`/`totales` -- la fila se quedaba con el precio que el
  // vendedor PIDIÓ, aunque el superadmin hubiera aprobado con otro
  // porcentaje y `enviarCotizacionAlHotel` (más abajo) mandara al cliente un
  // PDF con el precio de verdad aprobado. Dos números distintos para la
  // misma cotización: la fila que ve el equipo en el panel, y el documento
  // que ya tiene el hotel. `cotizacion` es la MISMA que unas líneas más
  // abajo arma el PDF y el Estimate de GoHighLevel -- guardar acá sus
  // `lineas`/`totales`, dentro del mismo update que reclama la fila, es lo
  // que garantiza que la fila JAMÁS pueda contradecir al documento: si este
  // `update` falla, `errorReclamo` corta la función más abajo y no se envía
  // nada (ni PDF ni correo) con un precio que la fila no llegó a registrar.
  // No hay ninguna ventana en la que el correo ya haya salido y este update
  // esté pendiente -- va ANTES de `enviarCotizacionAlHotel`, no después.
  const { data: reclamada, error: errorReclamo } = await db
    .from('cotizaciones')
    .update({
      updated_at: new Date().toISOString(),
      estado: ESTADO_RECLAMADO,
      aprobado_por: params.aprobador,
      resuelto_at: new Date().toISOString(),
      descuento_aprobado: descuentoFinal,
      lineas: cotizacion.lineas,
      totales: {
        subtotal: cotizacion.subtotal,
        ahorro: cotizacion.ahorro,
        tasaIva: cotizacion.tasaIva,
        iva: cotizacion.iva,
        total: cotizacion.total,
        bordadoEspecial: cotizacion.bordadoEspecial,
      },
    })
    .eq('id', params.id)
    .eq('estado', ESTADO_PENDIENTE)
    .select('id');

  if (errorReclamo) {
    console.error('[cotizador] No se pudo reclamar la cotización para aprobarla.', errorReclamo.message);
    return { ok: false, motivo: 'error', error: errorReclamo.message };
  }
  if (!reclamada || (reclamada as unknown[]).length === 0) {
    return { ok: false, motivo: 'no_pendiente', estadoActual: 'esperando_aprobacion (en disputa)' };
  }

  // Cabo suelto cerrado (ronda de correcciones, pantallas del descuento con
  // aprobación): `enviarCotizacionAlHotel` termina SIEMPRE con su propio
  // `update` que dice 'enviada' o 'error' (lib/cotizador/enviar.ts) -- pero
  // eso vale mientras la función corra hasta el final. Si algo revienta a
  // mitad de camino (hoy el único tramo sin su propio try/catch interno es
  // `crearEstimate`, pero cualquier excepción no prevista cae acá igual),
  // la fila se queda parada en `ESTADO_RECLAMADO` ('borrador') -- y a
  // diferencia de una cotización recién creada (que nace en 'borrador' y
  // ese es justo el huérfano YA aceptado en app/api/cotizacion/route.ts),
  // ÉSTA venía de 'esperando_aprobacion': una fila visible, con
  // `solicitado_por` y `descuento_personalizado` cargados, que un
  // superadmin estaba mirando en el panel. Quedar en 'borrador' la saca de
  // `/pendientes` (ya no está en ESTADO_PENDIENTE) sin haber salido nunca --
  // invisible para el superadmin que la esperaba Y para el vendedor que la
  // pidió, un huérfano peor que el ya aceptado.
  //
  // Por eso el `try/catch`: una excepción acá LIBERA la reclamación --
  // vuelve a 'esperando_aprobacion', sin `aprobado_por`/`resuelto_at`/
  // `descuento_aprobado` (esos se habían escrito recién, en el mismo update
  // que reclamó) -- así la fila reaparece en `/pendientes`, intacta, lista
  // para que cualquier superadmin la vuelva a intentar. No repara la
  // ventana de un timeout real de la plataforma (Vercel mata la función sin
  // darle chance a este `catch` de correr) -- ese es el mismo riesgo
  // aceptado de siempre, documentado en app/api/cotizacion/route.ts -- pero
  // sí cierra cualquier excepción de JavaScript (de red, de un `throw` en
  // `crearEstimate`, lo que sea) que hoy dejaba la fila exactamente en ese
  // estado ambiguo sin ninguna salida.
  //
  // `lineas`/`totales` vuelven acá al valor pedido original (`fila.lineas`/
  // `fila.totales`, tal como se leyeron al principio de esta función) --
  // nunca al recálculo del intento que reventó. Nada salió al hotel: dejar
  // escrito el precio del intento fallido mostraría en `/pendientes` un
  // total que nadie vio ni aprobó de verdad.
  let resultadoEnvio;
  try {
    resultadoEnvio = await enviarCotizacionAlHotel({
      id: fila.id,
      numero: fila.numero,
      cotizacion,
      cliente: fila.cliente,
      contactIdEntrada: fila.contact_id ?? undefined,
      reemplazaId: fila.reemplaza_a ?? null,
    });
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    console.error(
      '[cotizador] El envío de la cotización aprobada reventó a mitad de camino; se libera la reclamación para que no quede atascada en "borrador".',
      mensaje,
    );
    const { error: errorLiberar } = await db
      .from('cotizaciones')
      .update({
        updated_at: new Date().toISOString(),
        estado: ESTADO_PENDIENTE,
        aprobado_por: null,
        resuelto_at: null,
        descuento_aprobado: null,
        lineas: fila.lineas,
        totales: fila.totales,
      })
      .eq('id', params.id)
      .eq('estado', ESTADO_RECLAMADO);
    if (errorLiberar) {
      console.error(
        '[cotizador] Y ADEMÁS no se pudo liberar la reclamación: la fila queda en "borrador", revisar a mano.',
        errorLiberar.message,
      );
    }
    return { ok: false, motivo: 'error', error: mensaje };
  }

  // I4 (revision-final-2.md): `correoHotelOk` viaja acá -- `resultadoEnvio`
  // ya existe en este punto, calculado arriba -- para que el correo al
  // vendedor diga la verdad en los dos casos. Antes se llamaba con
  // `resultado: 'aprobada'` sin mirar `resultadoEnvio.correoOk`, así que un
  // fallo de Resend o de `renderizarCotizacion` dejaba la fila en 'error'
  // (correcto, `estadoFinal` de abajo) mientras el vendedor recibía "ya
  // salió al cliente" (incorrecto) y llamaba al hotel a hablar de un precio
  // que nunca le llegó.
  const aviso = await avisarResolucion(db, deps, {
    nombreVendedor: fila.solicitado_por,
    numero: fila.numero,
    cliente: fila.cliente,
    resultado: 'aprobada',
    descuentoPedido: fila.descuento_personalizado,
    descuentoAprobado: descuentoFinal,
    cambioPorcentaje,
    resueltoPor: params.aprobador,
    correoHotelOk: resultadoEnvio.correoOk,
  });
  if (!aviso.ok) {
    console.error('[cotizador] La cotización se aprobó, pero el aviso al vendedor no salió.', aviso.error);
  }

  return {
    ok: true,
    numero: fila.numero,
    estadoFinal: resultadoEnvio.correoOk ? 'enviada' : 'error',
    cambioPorcentaje,
    avisoEnviado: aviso.ok,
  };
}

export type ResultadoRechazar =
  | { ok: true; numero: string; avisoEnviado: boolean }
  | { ok: false; motivo: 'no_encontrado' }
  | { ok: false; motivo: 'no_pendiente'; estadoActual: string }
  | { ok: false; motivo: 'error'; error: string };

export type ParamsRechazar = { id: string; aprobador: string; motivo: string };

// A diferencia de `aprobar`, rechazar no hace ningún trabajo pesado: es un
// único update atómico, filtrado por `.eq('estado', ESTADO_PENDIENTE)` --
// mismo patrón de compare-and-swap que `/cerrar` (ESTADOS_CIERRE_INICIAL) y
// que `reenviarInvitacion` en lib/cotizador/equipo.ts. `.select(...)` trae
// de vuelta lo necesario para el correo, sin una segunda consulta.
export async function rechazar(
  db: Db,
  deps: DepsCorreo,
  params: ParamsRechazar,
): Promise<ResultadoRechazar> {
  const { data: filas, error } = await db
    .from('cotizaciones')
    .update({
      updated_at: new Date().toISOString(),
      estado: 'rechazada',
      aprobado_por: params.aprobador,
      resuelto_at: new Date().toISOString(),
      motivo_rechazo: params.motivo,
    })
    .eq('id', params.id)
    .eq('estado', ESTADO_PENDIENTE)
    .select('id, numero, cliente, solicitado_por, descuento_personalizado');

  if (error) {
    console.error('[cotizador] No se pudo rechazar la cotización.', error.message);
    return { ok: false, motivo: 'error', error: error.message };
  }

  if (!filas || (filas as unknown[]).length === 0) {
    // Ninguna fila coincidió: puede ser porque no existe, o porque ya no
    // está esperando (alguien más la resolvió en el medio). Se pregunta
    // aparte, sólo en este camino, para devolver un mensaje que diga cuál
    // de las dos pasó -- mismo criterio que /cerrar.
    const { data: filaActual } = await db.from('cotizaciones').select('estado').eq('id', params.id).maybeSingle();
    if (!filaActual) return { ok: false, motivo: 'no_encontrado' };
    return { ok: false, motivo: 'no_pendiente', estadoActual: (filaActual as { estado: string }).estado };
  }

  const fila = (filas as unknown[])[0] as {
    numero: string;
    cliente: ClienteCotizacion;
    solicitado_por: string | null;
    descuento_personalizado: DescuentoPersonalizado;
  };

  const aviso = await avisarResolucion(db, deps, {
    nombreVendedor: fila.solicitado_por,
    numero: fila.numero,
    cliente: fila.cliente,
    resultado: 'rechazada',
    descuentoPedido: fila.descuento_personalizado,
    cambioPorcentaje: false,
    motivoRechazo: params.motivo,
    resueltoPor: params.aprobador,
    // No hay envío al hotel que resolver en un rechazo -- `true` es sólo
    // para satisfacer el tipo, `cuerpoResolucionHtml`/`Texto` nunca lo leen
    // fuera de la rama `resultado === 'aprobada'`.
    correoHotelOk: true,
  });
  if (!aviso.ok) {
    console.error('[cotizador] La cotización se rechazó, pero el aviso al vendedor no salió.', aviso.error);
  }

  return { ok: true, numero: fila.numero, avisoEnviado: aviso.ok };
}

export type ResultadoCancelar =
  | { ok: true }
  | { ok: false; motivo: 'no_encontrado' }
  | { ok: false; motivo: 'no_pendiente'; estadoActual: string }
  | { ok: false; motivo: 'error'; error: string };

export type ParamsCancelar = { id: string };

// "El vendedor no puede editar mientras espera" (diseño): la única salida
// que tiene es cancelar -- la fila "vuelve a ser un borrador suyo,
// editable" (palabras del diseño). Literalmente: vuelve al mismo
// `ESTADO_RECLAMADO` ('borrador') que ya usa `aprobar` para reclamar la
// fila -- no es un estado nuevo, y ya se muestra bien en `VistaListado`
// (`ETIQUETAS_ESTADO.borrador`). No queda escondida ni en la cola del
// agente (`/api/cotizacion/borradores` filtra por `origen = 'agente'`,
// nunca 'humano') ni bloqueada en ningún lado -- el vendedor la retoma con
// "Duplicar" (siempre disponible, cualquier estado), que resuelve las
// líneas con los precios vigentes de hoy y, de querer el descuento de
// nuevo, lo vuelve a pedir desde cero. Ningún dato de la solicitud vieja
// (`descuento_personalizado`, `solicitado_por`) se borra: queda de rastro
// de que esta fila fue, en algún momento, una solicitud cancelada.
//
// Mismo compare-and-swap que `aprobar`/`rechazar`: sólo cancela si la fila
// TODAVÍA está esperando -- si un superadmin ya la aprobó o la rechazó en
// el medio, cancelar ahora la pisaría por encima de una decisión que ya se
// tomó (y, peor, en el caso de aprobada, encima de un envío que quizás ya
// salió al cliente).
//
// Sin chequeo de quién la pidió -- mismo criterio que `/cerrar` y
// `/reenviar` en este mismo módulo de cotizaciones: cualquier persona
// autenticada del equipo puede tocar cualquier fila, no sólo la propia (ver
// el comentario de `autenticarPeticion`, que ya documenta esa decisión para
// el resto del panel). No se introduce acá una regla de "sólo el dueño"
// que el resto del panel no tiene.
export async function cancelar(db: Db, params: ParamsCancelar): Promise<ResultadoCancelar> {
  const { data: canceladas, error } = await db
    .from('cotizaciones')
    .update({ updated_at: new Date().toISOString(), estado: ESTADO_RECLAMADO })
    .eq('id', params.id)
    .eq('estado', ESTADO_PENDIENTE)
    .select('id');

  if (error) {
    console.error('[cotizador] No se pudo cancelar la solicitud de aprobación.', error.message);
    return { ok: false, motivo: 'error', error: error.message };
  }

  if (canceladas && (canceladas as unknown[]).length > 0) {
    return { ok: true };
  }

  const { data: filaActual } = await db.from('cotizaciones').select('estado').eq('id', params.id).maybeSingle();
  if (!filaActual) return { ok: false, motivo: 'no_encontrado' };
  return { ok: false, motivo: 'no_pendiente', estadoActual: (filaActual as { estado: string }).estado };
}
