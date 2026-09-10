import 'server-only';
import {
  ZONAS_COMERCIALES,
  contactosPorZona,
  conCorreo,
  type ZonaComercial,
  type DepsGhlContactos,
} from '@/lib/campanas/contactos';
import { filtrarPermitidosParaCampana } from '@/lib/campanas/exclusiones';
import { normalizarCorreo } from '@/lib/campanas/baja';
import {
  crearCampana,
  enviarTanda,
  TAMANO_TANDA,
  type ClienteCampanas,
  type DepsEnvioCampana,
} from '@/lib/campanas/envio';
import { plantillaCargada } from '@/lib/campanas/plantillas';
import { progresoCampana } from '@/lib/campanas/progreso';

// El envío programado de la bandeja de campañas: un cron de Vercel (ver
// vercel.json, app/api/campanas/cron/route.ts) dispara de lunes a viernes,
// una vez al día, la plantilla 'inicial' -- SIN seguimientos, encargo
// explícito -- a una zona comercial a la vez, con un cupo diario que
// arranca chico (el dominio nunca mandó volumen) y sube hasta 100.
//
// LAS CINCO GARANTÍAS DE ESTE MÓDULO -- cada una con su propia sección más
// abajo:
//   1. La rampa: 25/25/50/50/75/100/100/... -- `topeParaDia`.
//   2. El tope de 100 nunca se pasa -- ni por la rampa (día 6 en adelante
//      se queda en 100) ni por `enviarTanda`, que además está acotado por
//      lo que acepta el LOTE de Resend (ver TAMANO_TANDA en envio.ts).
//   3. Nadie recibe el correo inicial dos veces -- `correosConInicialEnviado`,
//      consultado ANTES de armar la lista de destinatarios de una zona
//      nueva, sin importar en qué otra zona se le haya mandado antes.
//   4. Un reintento del cron el mismo día no duplica el cupo -- todo el
//      peso de esto vive en el rpc `campanas_reservar_cupo_diario`
//      (migración 0027): ver su comentario grande para el porqué.
//   5. El interruptor de apagado -- `estaPausado`/`establecerPausado`, y
//      `ejecutarEnvioProgramado` lo comprueba ANTES de tocar nada más.

// ---------------------------------------------------------------------
// 0) El orden de las zonas -- de la más chica a la más grande (direcciones
// únicas, medido contra el CRM el 2026-08-26), con "Revisión manual" al
// final SIEMPRE (son los 403 contactos que la importación no pudo ubicar
// en ninguna zona geográfica -- docs/ghl-smart-lists.md -- y da la
// casualidad de que además es la lista más grande de las trece, así que
// "la más chica primero" y "Revisión manual al final" son, acá, la MISMA
// orden, no dos reglas en tensión).
//
// Cuando una zona se queda sin pendientes, la SIGUIENTE arranca sola en el
// disparo del día siguiente -- nunca dentro de la misma corrida, aunque
// sobre cupo del día (ver `resolverObjetivo`, más abajo, y su comentario
// sobre por qué no encadena zonas dentro de una misma invocación cuando
// una zona TERMINA de mandar).
export const ORDEN_ZONAS_PROGRAMADO: readonly ZonaComercial[] = [
  'Guanacaste Interior', // 22
  'Caribe', // 50
  'Heredia / Norte GAM', // 117
  'Península Nicoya', // 147
  'Zona Norte', // 157
  'GAM Centro', // 172
  'Pacífico Central', // 185
  'Alajuela / Occidente', // 186
  'GAM Este / Cartago', // 194
  'Pacífico Sur', // 225
  'Guanacaste Costa', // 251
  'GAM Oeste', // 377
  'Revisión manual', // 403 -- siempre última.
];

// Falla al CARGAR el módulo (no al primer disparo del cron) si esta lista
// alguna vez se desincroniza de `ZONAS_COMERCIALES` -- mismo criterio que
// `construirPlantillaCargada` en plantillas.ts ("un error de arranque del
// servidor es muchísimo más barato de notar que una campaña ya mandada").
// Sin este chequeo, una zona nueva agregada a `ZONAS_COMERCIALES` sin
// tocar este arreglo simplemente nunca recibiría el envío programado, sin
// ningún error que lo delate.
if (
  ORDEN_ZONAS_PROGRAMADO.length !== ZONAS_COMERCIALES.length ||
  !ZONAS_COMERCIALES.every((zona) => ORDEN_ZONAS_PROGRAMADO.includes(zona))
) {
  throw new Error(
    'ORDEN_ZONAS_PROGRAMADO no coincide con ZONAS_COMERCIALES: revisá lib/campanas/programado.ts contra lib/campanas/contactos.ts.',
  );
}

// Marca, en `campanas.programada`, que esta campaña la armó el cron -- ver
// el comentario grande de la migración 0027.
export const MARCADOR_CAMPANA_PROGRAMADA = 'cron-programado';

// ---------------------------------------------------------------------
// 1) La rampa -- garantía 1 y parte de la 2. Función pura: nada de base,
// nada de reloj -- toma el número de día (1 = el primer día que el envío
// programado mandó algo, contando sólo los días que el cron corrió, no
// días calendario a secas -- ver `diaDeRampa`, abajo) y devuelve el tope
// de ESE día. Los cinco números y sus cuatro cortes son el encargo, letra
// por letra: "días 1 y 2 → 25; días 3 y 4 → 50; día 5 → 75; día 6 en
// adelante → 100" -- 100 es tope duro, la rama `else` de acá nunca
// devuelve nada más grande.
export function topeParaDia(dia: number): number {
  const d = Math.max(1, Math.trunc(dia));
  if (d <= 2) return 25;
  if (d <= 4) return 50;
  if (d === 5) return 75;
  return 100;
}

// Qué día de la rampa es "hoy": 1 + cuántos días PREVIOS a `fechaHoy` ya
// tienen una fila en `campanas_envio_diario` -- es decir, cuántas veces
// antes de hoy el envío programado llegó a reservar (o intentar reservar)
// cupo. No es "días calendario desde que se activó": un fin de semana no
// suma fila (el cron no corre), así que no hace avanzar la rampa -- y si
// el cron estuviera pausado varios días, tampoco avanza, porque
// `ejecutarEnvioProgramado` corta ANTES de llegar a reservar cupo cuando
// está pausado (ver más abajo) y por lo tanto nunca escribe una fila esos
// días.
export async function diaDeRampa(db: ClienteCampanas, fechaHoy: string): Promise<number> {
  const { count, error } = await db
    .from('campanas_envio_diario')
    .select('fecha', { count: 'exact', head: true })
    .lt('fecha', fechaHoy);
  if (error) {
    throw new Error(`No se pudo calcular el dia de rampa: ${error.message}`);
  }
  return (count ?? 0) + 1;
}

// Reserva, de forma atómica (rpc `campanas_reservar_cupo_diario`, migración
// 0027), hasta `solicitado` cupos del día `fechaHoy` -- nunca más del tope
// de ese día. El tope lo calcula ACÁ (`topeParaDia`, con el día que
// calcula `diaDeRampa`) y viaja como parámetro al rpc -- el rpc sólo lo usa
// la PRIMERA vez que toca la fila de ese día; cualquier llamada posterior
// (un reintento del cron el mismo día) lo ignora y usa el tope que ya
// quedó fijado -- ver el comentario grande de esa función en la migración.
//
// Garantía 4 (cupo ante un doble disparo): esta función no decide nada por
// su cuenta salvo el tope -- la resta contra lo ya reservado hoy vive
// ENTERA en el rpc, en una sola sentencia atómica, así que dos llamadas
// concurrentes a `reservarCupoDiario` (dos invocaciones del cron el mismo
// día) nunca pueden, juntas, reservar más que el tope del día.
export async function reservarCupoDiario(
  db: ClienteCampanas,
  fechaHoy: string,
  solicitado: number,
): Promise<number> {
  if (solicitado <= 0) return 0;
  const dia = await diaDeRampa(db, fechaHoy);
  const tope = topeParaDia(dia);
  const { data, error } = await db.rpc('campanas_reservar_cupo_diario', {
    p_fecha: fechaHoy,
    p_tope: tope,
    p_solicitado: solicitado,
  });
  if (error) {
    throw new Error(`No se pudo reservar el cupo diario: ${error.message}`);
  }
  return Math.max(0, Number(data ?? 0));
}

// ---------------------------------------------------------------------
// 2) El interruptor (garantía 5) -- `campanas_programado_config`, fila
// única (migración 0027).

export type EstadoProgramado = { pausado: boolean; pausadoPor: string | null; pausadoAt: string | null };

async function leerConfig(db: ClienteCampanas): Promise<EstadoProgramado | null> {
  const { data, error } = await db
    .from('campanas_programado_config')
    .select('pausado, pausado_por, pausado_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) {
    throw new Error(`No se pudo leer el interruptor del envio programado: ${error.message}`);
  }
  if (!data) return null;
  const fila = data as { pausado: boolean; pausado_por: string | null; pausado_at: string | null };
  return { pausado: Boolean(fila.pausado), pausadoPor: fila.pausado_por ?? null, pausadoAt: fila.pausado_at ?? null };
}

// Lo que la pantalla necesita para mostrar el estado -- "pausado por Ana el
// 9 de setiembre" o "activo". Si por lo que sea la fila no existe (no
// debería pasar tras la migración 0027, que la siembra), se informa como
// pausado: mismo criterio de "fallar cerrado" que `estaPausado`, abajo --
// nunca se le dice a nadie que el envío está activo si no se pudo
// confirmar de verdad.
export async function estadoProgramado(db: ClienteCampanas): Promise<EstadoProgramado> {
  const fila = await leerConfig(db);
  return fila ?? { pausado: true, pausadoPor: null, pausadoAt: null };
}

// Lo único que `ejecutarEnvioProgramado` necesita saber antes de tocar
// nada más: ¿está pausado? FALLA CERRADO -- si no se puede leer la fila
// (falta, o la consulta falla), se trata como PAUSADO. Nunca al revés: un
// error de lectura nunca puede terminar mandando correo de más porque se
// interpretó silenciosamente como "no está pausado".
export async function estaPausado(db: ClienteCampanas): Promise<boolean> {
  const fila = await leerConfig(db);
  return fila === null ? true : fila.pausado;
}

// Escribe el interruptor -- lo que la pantalla llama al tocar "Pausar"/
// "Reanudar" (encargo, punto 6: "sin necesidad de desplegar"). `quien` es
// el nombre del superadmin que lo tocó (mismo criterio que `creado_por` en
// `campanas`/`cancelada_por`): se guarda el nombre, no una referencia, para
// que quede legible aunque esa persona se vaya del equipo.
export async function establecerPausado(
  db: ClienteCampanas,
  pausado: boolean,
  quien: string,
  ahora: () => Date = () => new Date(),
): Promise<void> {
  const { error } = await db
    .from('campanas_programado_config')
    .update({ pausado, pausado_por: quien, pausado_at: ahora().toISOString() })
    .eq('id', 1);
  if (error) {
    throw new Error(`No se pudo actualizar el interruptor del envio programado: ${error.message}`);
  }
}

// ---------------------------------------------------------------------
// 3) "Nadie recibe el correo inicial dos veces" (garantía 3) -- global,
// contra CUALQUIER campaña con plantilla 'inicial' (armada por el cron o a
// mano desde la pantalla), no sólo contra las de este módulo. El índice
// único de la migración 0019 (`campana_id, correo`) sólo evita que un mismo
// correo se repita DENTRO de una campaña -- nada impide, a nivel de base,
// que ese correo aparezca en dos campañas 'inicial' distintas (una por
// zona). Este filtro es lo que cierra esa puerta del lado de la
// aplicación, ANTES de que `crearCampana` fije la lista de una zona nueva.
async function correosConInicialEnviado(db: ClienteCampanas): Promise<Set<string>> {
  const { data: campanasIniciales, error: errorCampanas } = await db
    .from('campanas')
    .select('id')
    .eq('plantilla', 'inicial');
  if (errorCampanas) {
    throw new Error(`No se pudo listar las campanas de plantilla inicial: ${errorCampanas.message}`);
  }
  const ids = ((campanasIniciales ?? []) as { id: string }[]).map((c) => c.id);
  if (ids.length === 0) return new Set();

  // Sólo 'enviado' cuenta como "ya se le mandó" -- un destinatario que
  // quedó 'error' en otra zona (Resend no lo confirmó) nunca recibió nada
  // de verdad, así que sigue siendo elegible acá. Mismo criterio que
  // `filtrarPermitidosParaCampana` (exclusiones.ts): se trae la lista
  // entera a memoria en vez de filtrar por miles de correos con `.in()` --
  // a esta escala (unos pocos miles de filas 'enviado' cuando la campaña
  // de las trece zonas termine) es la misma cuenta que ya hace ese módulo
  // con `bajas_correo`.
  const { data: envios, error: errorEnvios } = await db
    .from('campanas_envios')
    .select('correo')
    .in('campana_id', ids)
    .eq('estado', 'enviado');
  if (errorEnvios) {
    throw new Error(`No se pudo listar los correos con el inicial ya enviado: ${errorEnvios.message}`);
  }
  return new Set(((envios ?? []) as { correo: string }[]).map((f) => normalizarCorreo(f.correo)));
}

// La campaña PROGRAMADA (columna `programada`, migración 0027) de
// plantilla 'inicial' de una zona, si ya existe. `null` si esta zona
// todavía no tiene ninguna -- es la señal de "hay que crearla" en
// `resolverObjetivo`.
async function campanaProgramadaDeZona(db: ClienteCampanas, zona: ZonaComercial): Promise<{ id: string } | null> {
  const { data, error } = await db
    .from('campanas')
    .select('id')
    .eq('zona', zona)
    .eq('plantilla', 'inicial')
    .eq('programada', true)
    .maybeSingle();
  if (error) {
    throw new Error(`No se pudo buscar la campana programada de ${zona}: ${error.message}`);
  }
  return (data as { id: string } | null) ?? null;
}

// ---------------------------------------------------------------------
// 4) A qué zona le toca hoy, y con qué campaña.
export type ObjetivoProgramado =
  | {
      tipo: 'zona';
      zona: ZonaComercial;
      campanaId: string;
      // Cuántos quedan pendientes de ESTA zona en este momento -- el techo
      // de lo que `ejecutarEnvioProgramado` va a pedirle al cupo diario.
      pendientes: number;
      campanaNueva: boolean;
    }
  | { tipo: 'sin_pendientes' };

// Recorre `ORDEN_ZONAS_PROGRAMADO` de punta a punta y devuelve la PRIMERA
// zona que todavía tiene trabajo:
//   - Si ya tiene una campaña programada con pendientes > 0: esa es la
//     zona de hoy -- se sigue mandando la MISMA campaña, nunca se crea una
//     segunda para la misma zona.
//   - Si ya tiene una campaña programada SIN pendientes: esa zona ya
//     terminó -- se pasa a la siguiente SIN mandar nada hoy por ella (el
//     encargo es explícito: "la siguiente arranca sola en el disparo del
//     día siguiente", nunca dentro de la misma corrida que terminó la
//     anterior, aunque sobre cupo del día).
//   - Si todavía no tiene ninguna campaña: se arma AHORA (contra GHL, con
//     el filtro de "ya recibió el inicial" y el de bajas) -- si después de
//     los dos filtros no queda nadie elegible, esta zona se trata como YA
//     HECHA (se pasa a la siguiente, en la MISMA corrida: no se creó
//     ninguna campaña, así que no hay "el turno de una zona" que
//     respetar -- distinto del caso de arriba, donde SÍ hubo una campaña
//     que de verdad estuvo mandando).
// Si las trece zonas ya tienen su campaña terminada, no hay nada que hacer
// hoy -- `{ tipo: 'sin_pendientes' }`.
export async function resolverObjetivo(db: ClienteCampanas, deps: DepsGhlContactos): Promise<ObjetivoProgramado> {
  for (const zona of ORDEN_ZONAS_PROGRAMADO) {
    const existente = await campanaProgramadaDeZona(db, zona);
    if (existente) {
      const progreso = await progresoCampana(db, existente.id);
      if (progreso.pendientes > 0) {
        return { tipo: 'zona', zona, campanaId: existente.id, pendientes: progreso.pendientes, campanaNueva: false };
      }
      continue; // esta zona ya terminó -- a la siguiente.
    }

    const resultadoZona = await contactosPorZona(zona, deps);
    if (!resultadoZona.ok) {
      throw new Error(`No se pudo consultar el CRM para armar ${zona}: ${resultadoZona.error}`);
    }
    const conCorreoZona = conCorreo(resultadoZona.contactos);

    const yaEnviados = await correosConInicialEnviado(db);
    const sinRepetir = conCorreoZona.filter((d) => !yaEnviados.has(normalizarCorreo(d.correo)));
    // Nadie elegible en esta zona (todos ya recibieron el inicial en otra
    // zona) -- no hay ninguna campaña que crear ni ningún turno que
    // reservarle: se pasa de largo, en la MISMA corrida, a la siguiente.
    if (sinRepetir.length === 0) continue;

    const permitidos = await filtrarPermitidosParaCampana(sinRepetir, db);
    if (permitidos.length === 0) continue; // todos dados de baja -- mismo criterio.

    const cargada = plantillaCargada('inicial');
    const resultadoCrear = await crearCampana(
      {
        zona,
        plantilla: 'inicial',
        asunto: cargada.asunto,
        previewText: cargada.previewText,
        html: cargada.html,
        creadoPor: MARCADOR_CAMPANA_PROGRAMADA,
        programada: true,
      },
      permitidos,
      db,
    );
    if (!resultadoCrear.ok) {
      throw new Error(`No se pudo crear la campana programada de ${zona}: ${resultadoCrear.error}`);
    }
    // `crearCampana` puede devolver 0 si todos los `permitidos` compartían
    // correo entre sí (`ignoreDuplicates`, ver el comentario grande de esa
    // función) -- mismo desenlace que "nadie elegible": a la siguiente.
    if (resultadoCrear.destinatarios === 0) continue;

    return {
      tipo: 'zona',
      zona,
      campanaId: resultadoCrear.campanaId,
      pendientes: resultadoCrear.destinatarios,
      campanaNueva: true,
    };
  }
  return { tipo: 'sin_pendientes' };
}

// ---------------------------------------------------------------------
// 5) El disparo del día -- lo que `app/api/campanas/cron/route.ts` llama.
export type DepsEnvioProgramado = Omit<DepsEnvioCampana, 'ahora' | 'limiteTanda'> & DepsGhlContactos;

export type ResultadoEnvioProgramado =
  | { ok: true; accion: 'pausado' }
  | { ok: true; accion: 'sin_pendientes' }
  | { ok: true; accion: 'cupo_agotado'; zona: ZonaComercial }
  | {
      ok: true;
      accion: 'enviado';
      zona: ZonaComercial;
      campanaId: string;
      campanaNueva: boolean;
      cupoReservado: number;
      procesados: number;
      enviados: number;
      fallidos: number;
    }
  | { ok: false; error: string };

// Un solo `ahora` para TODO el disparo -- la fecha del cupo diario (se
// calcula acá) y el reloj que `enviarTanda` usa para decidir qué reserva
// cuenta como vencida (se le pasa el MISMO, no uno aparte) -- para que una
// prueba pueda fijar el reloj una sola vez y confiar en que las dos partes
// lo ven igual.
export async function ejecutarEnvioProgramado(
  db: ClienteCampanas,
  deps: DepsEnvioProgramado,
  ahora: () => Date = () => new Date(),
): Promise<ResultadoEnvioProgramado> {
  let pausado: boolean;
  try {
    pausado = await estaPausado(db);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  // Garantía 5, el corazón de todo el módulo: nada de lo que sigue -- ni
  // resolver a qué zona le toca, ni tocar GHL, ni reservar cupo, ni llamar
  // a Resend -- corre si el interruptor está pausado. Se comprueba PRIMERO,
  // antes de cualquier otro trabajo.
  if (pausado) return { ok: true, accion: 'pausado' };

  let objetivo: ObjetivoProgramado;
  try {
    objetivo = await resolverObjetivo(db, deps);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (objetivo.tipo === 'sin_pendientes') return { ok: true, accion: 'sin_pendientes' };

  const fechaHoy = ahora().toISOString().slice(0, 10);
  // Nunca se pide más de `TAMANO_TANDA` (100) -- garantía 2 -- sin importar
  // cuántos pendientes tenga la zona (GAM Oeste sola tiene 377).
  const solicitado = Math.min(objetivo.pendientes, TAMANO_TANDA);

  let cupo: number;
  try {
    cupo = await reservarCupoDiario(db, fechaHoy, solicitado);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (cupo <= 0) return { ok: true, accion: 'cupo_agotado', zona: objetivo.zona };

  const resultado = await enviarTanda(
    objetivo.campanaId,
    { resendApiKey: deps.resendApiKey, remitente: deps.remitente, fetchImpl: deps.fetchImpl, ahora, limiteTanda: cupo },
    db,
  );
  if (!resultado.ok) return { ok: false, error: resultado.error };

  return {
    ok: true,
    accion: 'enviado',
    zona: objetivo.zona,
    campanaId: objetivo.campanaId,
    campanaNueva: objetivo.campanaNueva,
    cupoReservado: cupo,
    procesados: resultado.procesados,
    enviados: resultado.enviados,
    fallidos: resultado.fallidos,
  };
}
