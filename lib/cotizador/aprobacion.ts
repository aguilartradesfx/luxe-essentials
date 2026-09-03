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
import type { DescuentoPersonalizado } from '@/lib/cotizador/tipos';

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

// La fila tal como la necesita este módulo -- ni la forma completa de la
// tabla (`vendedor`, `pdf_ruta`, etc. no hacen falta acá) ni la recortada de
// /listado (que a propósito no trae `lineas`, y acá sí hacen falta para
// recalcular si el porcentaje cambia).
type FilaPendiente = {
  id: string;
  estado: string;
  numero: string;
  cliente: ClienteCotizacion;
  lineas: Array<{ skuId: string; cantidad: number }>;
  totales: { tasaIva: number; bordadoEspecial: boolean };
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
  lineas: Array<{ skuId: string; cantidad: number }>;
  totales: { total: number; subtotal: number; iva: number; tasaIva: number; bordadoEspecial: boolean };
  descuento_personalizado: DescuentoPersonalizado;
  solicitado_por: string | null;
  vendedor: string | null;
  contact_id: string | null;
  reemplaza_a: string | null;
  reemplaza_a_numero: string | null;
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
  return { ok: true, cotizaciones: (data ?? []) as FilaListado[] };
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

  let cotizacion;
  try {
    cotizacion = calcular(
      fila.lineas.map((l) => ({ skuId: l.skuId, cantidad: l.cantidad })),
      CATALOGO,
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
  const { data: reclamada, error: errorReclamo } = await db
    .from('cotizaciones')
    .update({
      updated_at: new Date().toISOString(),
      estado: ESTADO_RECLAMADO,
      aprobado_por: params.aprobador,
      resuelto_at: new Date().toISOString(),
      descuento_aprobado: descuentoFinal,
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

  const resultadoEnvio = await enviarCotizacionAlHotel({
    id: fila.id,
    numero: fila.numero,
    cotizacion,
    cliente: fila.cliente,
    contactIdEntrada: fila.contact_id ?? undefined,
    reemplazaId: fila.reemplaza_a ?? null,
  });

  const aviso = await avisarResolucion(db, deps, {
    nombreVendedor: fila.solicitado_por,
    numero: fila.numero,
    cliente: fila.cliente,
    resultado: 'aprobada',
    descuentoPedido: fila.descuento_personalizado,
    descuentoAprobado: descuentoFinal,
    cambioPorcentaje,
    resueltoPor: params.aprobador,
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
  });
  if (!aviso.ok) {
    console.error('[cotizador] La cotización se rechazó, pero el aviso al vendedor no salió.', aviso.error);
  }

  return { ok: true, numero: fila.numero, avisoEnviado: aviso.ok };
}
