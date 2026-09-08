import 'server-only';
import type { Permitido } from '@/lib/campanas/exclusiones';
import type { DestinatarioCampana } from '@/lib/campanas/contactos';
import { normalizarCorreo, enlacePaginaBaja, cabecerasListaBaja } from '@/lib/campanas/baja';
import { renderizarPlantilla } from '@/lib/campanas/marcadores';

// Crea una campaña (con su lista fija de destinatarios) y la manda por
// tandas, retomables -- ver el comentario grande de la migración 0019
// (supabase/migrations/0019_campanas.sql) para el diseño completo de la
// tabla `campanas_envios` y de `campanas_reclamar_pendientes`, que es lo
// que hace posible todo lo de acá.

const RESEND_BATCH_URL = 'https://api.resend.com/emails/batch';

// Las cuatro plantillas (Tarea 2 de la bandeja de campañas -- todavía sin
// el texto real, ver el reporte de esta tarea): la inicial y tres
// seguimientos. Mismo valor que el `check` de `campanas.plantilla`
// (migración 0019) -- vive acá también para que escribir una quinta sea un
// error de TypeScript en vez de un 23514 de Postgres recién al desplegar.
export const PLANTILLAS = ['inicial', 'seguimiento_1', 'seguimiento_2', 'seguimiento_3'] as const;
export type PlantillaCampana = (typeof PLANTILLAS)[number];

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
  plantilla: PlantillaCampana;
  asunto: string;
  previewText?: string;
  // El HTML final, con los tres marcadores {{nombre}}/{{empresa}}/
  // {{unsubscribe_url}} todavía sin resolver -- se resuelven por
  // destinatario en `enviarTanda`.
  html: string;
  creadoPor: string;
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
      plantilla: p.plantilla,
      asunto: p.asunto,
      preview_text: p.previewText ?? null,
      html: p.html,
      creado_por: p.creadoPor,
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

export type DepsEnvioCampana = {
  resendApiKey: string;
  remitente: string;
  fetchImpl?: typeof fetch;
  // Inyectable para poder probar qué reserva cuenta como "vencida" sin
  // depender del reloj real.
  ahora?: () => Date;
};

export type ResultadoTanda =
  | { ok: true; procesados: number; enviados: number; fallidos: number; terminada: boolean }
  | { ok: false; error: string };

type FilaEnvio = { id: string; correo: string; nombre_crm: string };

// Manda UNA tanda (hasta `TAMANO_TANDA` destinatarios) de una campaña ya
// creada, y devuelve un resumen. Se llama repetidas veces -- desde la
// pantalla (parte 2), un botón "continuar" o un intervalo -- hasta que
// `terminada` da `true`. Cada llamada es independiente y retomable: no
// hace falta pasarle ningún cursor ni recordar dónde quedó la anterior,
// porque eso vive en `campanas_envios` (migración 0019).
//
// SOBRE LOS FALLOS -- la distinción que sostiene todo el diseño:
//   - Un fallo de la LLAMADA A RESEND ENTERA (red caída, Resend devuelve
//     un 4xx/5xx, JSON ilegible): no se marca NINGUNA fila. Se asume que,
//     si la petición no terminó en un 2xx, Resend no aceptó ningún correo
//     de esta tanda -- así que no hay nada que deshacer, sólo dejar la
//     reserva ('pendiente', con `actualizado_at` reciente) donde estaba.
//     Pasados `MINUTOS_RESERVA_VENCIDA`, `campanas_reclamar_pendientes` la
//     vuelve a entregar sola, en una tanda futura. Así es como "un fallo
//     de Resend" queda retomable sin ningún código especial para ese caso
//     -- es el MISMO mecanismo que recupera una tanda cortada a mitad de
//     camino por cualquier otro motivo (el servidor se corta, la pestaña
//     se cierra): ambos dejan la fila 'pendiente' con una reserva que,
//     tarde o temprano, vence.
//   - Un fallo de UN destinatario dentro de una llamada que SÍ tuvo éxito
//     (Resend contestó 2xx pero no confirmó un id para ese ítem en
//     particular): esa fila SÍ se marca 'error', de forma permanente. No
//     se reintenta sola -- el resto de la tanda ya se dio por enviada, y
//     reintentar automáticamente sólo a éste podría mandarlo dos veces si
//     el problema fue de lectura de la respuesta y no de que Resend lo
//     haya rechazado de verdad. "Un fallo de un destinatario no tumba la
//     tanda: se registra y se sigue" -- el resto de `enviados` sigue su
//     curso normal.
export async function enviarTanda(
  campanaId: string,
  deps: DepsEnvioCampana,
  db: ClienteCampanas,
): Promise<ResultadoTanda> {
  const { resendApiKey, remitente, fetchImpl = fetch, ahora = () => new Date() } = deps;

  if (!resendApiKey) return { ok: false, error: 'Falta RESEND_API_KEY: no se pudo enviar.' };
  if (!remitente) return { ok: false, error: 'Falta el remitente: no se pudo enviar.' };

  const { data: campana, error: errorCampana } = await db
    .from('campanas')
    .select('asunto, html')
    .eq('id', campanaId)
    .maybeSingle();
  if (errorCampana) return { ok: false, error: `No se pudo leer la campaña: ${errorCampana.message}` };
  if (!campana) return { ok: false, error: `No existe la campaña ${campanaId}.` };

  const vencidoDesde = new Date(ahora().getTime() - MINUTOS_RESERVA_VENCIDA * 60_000).toISOString();

  const { data: reservados, error: errorReclamo } = await db.rpc(RPC_RECLAMAR, {
    p_campana_id: campanaId,
    p_limite: TAMANO_TANDA,
    p_vencido_desde: vencidoDesde,
  });
  if (errorReclamo) return { ok: false, error: `No se pudo reservar la tanda: ${errorReclamo.message}` };

  const filas = (reservados ?? []) as FilaEnvio[];
  if (filas.length === 0) {
    return { ok: true, procesados: 0, enviados: 0, fallidos: 0, terminada: true };
  }

  const payload = filas.map((f) => ({
    from: remitente,
    to: [f.correo],
    subject: campana.asunto as string,
    html: renderizarPlantilla(campana.html as string, {
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
    // No se toca ninguna fila -- ver el comentario grande de arriba,
    // "SOBRE LOS FALLOS". Un error de red se retoma solo.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const texto = await res.text();
  if (!res.ok) {
    // Mismo criterio que el catch de arriba: un 4xx/5xx de Resend para
    // TODA la tanda no marca nada -- se retoma solo.
    return { ok: false, error: `Resend ${res.status}: ${texto.slice(0, 300)}` };
  }

  let datos: { data?: { id?: string }[] };
  try {
    datos = JSON.parse(texto);
  } catch {
    return { ok: false, error: `Resend respondió con JSON ilegible: ${texto.slice(0, 200)}` };
  }

  const resultados = datos.data ?? [];
  let enviados = 0;
  let fallidos = 0;

  await Promise.all(
    filas.map(async (f, i) => {
      const resendId = resultados[i]?.id;
      const cambios = resendId
        ? { estado: 'enviado', resend_id: resendId, error: null, actualizado_at: new Date().toISOString() }
        : {
            estado: 'error',
            error: 'Resend no confirmó el envío para este destinatario.',
            actualizado_at: new Date().toISOString(),
          };
      if (resendId) enviados++;
      else fallidos++;

      const { error } = await db.from('campanas_envios').update(cambios).eq('id', f.id);
      if (error) {
        // Ventana angosta y aceptada: si `resendId` existe, Resend YA
        // mandó este correo -- no se puede "reintentar" desde acá sin
        // arriesgar un envío duplicado si el problema fue sólo de
        // escribir el resultado. Se deja constancia ruidosa para que
        // alguien lo reconcilie a mano; ver el reporte de esta tarea.
        console.error('[campanas] No se pudo cerrar el registro de un envío.', f.id, error.message);
      }
    }),
  );

  return {
    ok: true,
    procesados: filas.length,
    enviados,
    fallidos,
    // Menos de una tanda completa reclamada sólo puede pasar cuando ya no
    // quedaba más para reclamar en este momento -- `campanas_reclamar_pendientes`
    // siempre intenta llevarse hasta `TAMANO_TANDA`.
    terminada: filas.length < TAMANO_TANDA,
  };
}
