// La única implementación de "enviar una cotización al hotel": Estimate +
// Opportunity en GoHighLevel, el workflow de aviso interno, el PDF, el
// correo con el adjunto, la nota en el contacto y el update final de la
// fila. Hasta la fase 5 este bloque vivía inline en
// app/api/cotizacion/route.ts (la única forma de mandar una cotización:
// crearla y enviarla en la misma petición). Con el descuento personalizado
// con aprobación (docs/superpowers/specs/2026-09-02-descuento-aprobacion-design.md)
// aparece un SEGUNDO camino que también termina en "enviar esta
// cotización" -- aprobar una que quedó esperando, en
// lib/cotizador/aprobacion.ts -- y duplicar esta cadena (cuatro llamadas a
// GoHighLevel, render de PDF, subida a Storage, firma de enlace, correo con
// adjunto, nota) en dos archivos es exactamente el tipo de cosa que
// diverge en silencio la segunda vez que alguien la toca. Se extrae acá una
// sola vez; las dos rutas la llaman.
import 'server-only';
import { crearEstimate, notaDeCotizacion } from '@/lib/cotizador/ghl';
import { agregarNota, dispararWorkflow } from '@/lib/agente/acciones';
import { config as configAgente } from '@/lib/agente/config';
import { renderizarCotizacion } from '@/lib/cotizador/documento';
import { guardarPdf, enlaceFirmado } from '@/lib/cotizador/almacen';
import { enviarCotizacion } from '@/lib/cotizador/correo';
import { supabaseAdmin } from '@/lib/supabase/server';
import type { Cotizacion } from '@/lib/cotizador/tipos';

// Mismo valor que usaba app/api/cotizacion/route.ts (Tarea 7): cuántos días
// queda vigente el precio cotizado. El PDF, el correo y el Estimate de
// GoHighLevel tienen que decir la misma fecha.
export const DIAS_VIGENCIA = 30;

// "Modificar" (migración 0016): sobre qué estados de la cotización VIEJA se
// puede pedir un reemplazo -- ver el comentario grande que traía este mismo
// bloque en app/api/cotizacion/route.ts antes de esta extracción. Se
// conserva acá porque `enviarCotizacionAlHotel` es quien de verdad marca la
// vieja como reemplazada, y la ruta de aprobación (lib/cotizador/aprobacion.ts)
// necesita el mismo conjunto para validar `reemplazaId` al recibir la
// solicitud -- una sola fuente de verdad para las dos.
export const ESTADOS_MODIFICABLES: readonly string[] = ['creada', 'enviada'];

export type ClienteCotizacion = {
  nombre: string;
  empresa?: string;
  email: string;
  telefono?: string;
  direccion?: string;
};

export type ParamsEnviarCotizacion = {
  // Id y numero de la fila que YA existe en `cotizaciones` -- esta función
  // nunca inserta, sólo actualiza. `numero` es el que puso el trigger de la
  // migración 0010 al insertar, nunca se deriva del id.
  id: string;
  numero: string;
  cotizacion: Cotizacion;
  cliente: ClienteCotizacion;
  // El contactId que ya se tenía en la mano ANTES de llamar a GoHighLevel
  // (el que mandó el vendedor, o el de la cotización que se está
  // reemplazando). `crearEstimate` puede resolver uno nuevo si esto viene
  // vacío.
  contactIdEntrada?: string;
  // "Modificar": el id de la cotización que ésta reemplaza, o `null`/`undefined`
  // si no viene de esa acción. Sólo se marca 'reemplazada' cuando el correo
  // de ÉSTA salió bien -- ver el comentario grande más abajo.
  reemplazaId?: string | null;
};

export type ResultadoEnviarCotizacion = {
  ghl: { estimateId: string } | { error: string };
  pdf: { ruta: string } | null;
  correo: { resendId: string } | { error: string };
  // Para que quien llama (route.ts, aprobacion.ts) sepa si el estado final
  // quedó 'enviada' o 'error' sin tener que repetir el `if` sobre `correo`.
  correoOk: boolean;
};

export async function enviarCotizacionAlHotel(
  p: ParamsEnviarCotizacion,
): Promise<ResultadoEnviarCotizacion> {
  const { id, numero, cotizacion, cliente, contactIdEntrada, reemplazaId } = p;

  // GoHighLevel primero (Tarea 7), fuera del camino crítico del envío real
  // al cliente. Un colgado acá (sin `AbortSignal` propio) no puede tumbar
  // el registro de un correo que sí salió, porque el correo todavía no se
  // intentó.
  const ghl = await crearEstimate(
    { cotizacion, cliente, contactId: contactIdEntrada },
    {
      apiKey: process.env.LUXE_GHL_API_KEY ?? '',
      locationId: process.env.LUXE_GHL_LOCATION_ID ?? '',
    },
  );

  // El contactId se guarda aunque GoHighLevel haya fallado después: si el
  // contacto se llegó a resolver (recibido del vendedor, del reemplazo, o
  // recién creado por `crearEstimate`), es un dato gratis que ya tenemos en
  // la mano y que de otro modo se pierde sin dejar rastro en la fila.
  const contactId = ghl.contactId ?? contactIdEntrada ?? null;

  // Workflow "Cotización nueva": avisa por dentro en cuanto la cotización
  // queda registrada. Fire-and-forget, mismo criterio que el resto del
  // enriquecimiento de GoHighLevel: perder este aviso es molesto, perder la
  // cotización es grave.
  let errorWorkflowCotizacion: string | undefined;
  if (contactId) {
    errorWorkflowCotizacion = await dispararWorkflow(
      contactId,
      configAgente.WORKFLOW_COTIZACION_NUEVA,
      { apiKey: process.env.LUXE_GHL_API_KEY ?? '' },
    );
    if (errorWorkflowCotizacion) {
      console.error(
        '[cotizador] No se pudo disparar el workflow de cotización nueva en GoHighLevel.',
        errorWorkflowCotizacion,
      );
    }
  }

  const emitida = new Date();
  const vence = new Date(emitida);
  vence.setDate(vence.getDate() + DIAS_VIGENCIA);

  // Enriquecimiento (Tarea 5): la fila ya existe, así que nada de lo que
  // sigue puede perderla -- a lo peor queda marcada 'error' y recuperable a
  // mano. `renderizarCotizacion` es la única pieza que sí puede lanzar
  // (guardarPdf/enlaceFirmado/enviarCotizacion nunca lo hacen).
  let pdfBuffer: Buffer | null = null;
  try {
    pdfBuffer = await renderizarCotizacion({ numero, cotizacion, cliente, emitida, vence });
  } catch (err) {
    console.error(
      '[cotizador] No se pudo generar el PDF de la cotización.',
      err instanceof Error ? err.message : String(err),
    );
  }

  let pdfRuta: string | null = null;
  let enlacePdf = '';
  // Regla que no se negocia: si no hay PDF, no se manda un correo que diga
  // "le adjunto la cotización" sin adjunto.
  let correoResultado: { ok: true; resendId: string } | { ok: false; error: string } = {
    ok: false,
    error: 'No se generó el PDF: no se intentó enviar el correo.',
  };

  if (pdfBuffer) {
    const guardado = await guardarPdf({ id, numero, pdf: pdfBuffer }, supabaseAdmin());
    if (!guardado.ok) {
      console.error('[cotizador] No se pudo guardar el PDF en el almacenamiento.', guardado.error);
      correoResultado = { ok: false, error: guardado.error };
    } else {
      pdfRuta = guardado.ruta;
      const firmado = await enlaceFirmado(guardado.ruta, supabaseAdmin());
      if (!firmado.ok) {
        console.error('[cotizador] No se pudo firmar el enlace del PDF.', firmado.error);
      }
      enlacePdf = firmado.ok ? firmado.url : '';
      correoResultado = await enviarCotizacion(
        { numero, cliente, total: cotizacion.total, vence, pdf: pdfBuffer, enlace: enlacePdf },
        {
          apiKey: process.env.RESEND_API_KEY ?? '',
          remitente: process.env.LUXE_CORREO_REMITENTE ?? '',
        },
      );
    }
  }

  // Tarea 12 -- la nota en el contacto de GoHighLevel. Sólo cuando el correo
  // salió de verdad y hay un contacto al que anotarle algo.
  let notaError: string | undefined;
  if (correoResultado.ok && contactId) {
    let textoNota: string | undefined;
    try {
      textoNota = notaDeCotizacion({ numero, total: cotizacion.total, vence, enlace: enlacePdf });
    } catch (err) {
      console.error(
        '[cotizador] BUG: no se pudo construir el texto de la nota de la cotización.',
        err instanceof Error ? err.message : String(err),
      );
    }
    if (textoNota) {
      notaError = await agregarNota(contactId, textoNota, { apiKey: process.env.LUXE_GHL_API_KEY ?? '' });
      if (notaError) {
        console.error('[cotizador] No se pudo agregar la nota de la cotización en GoHighLevel.', notaError);
      }
    }
  }

  const erroresGhl = [
    ghl.ok ? ghl.opportunityError : ghl.error,
    errorWorkflowCotizacion,
    notaError,
  ].filter((e): e is string => Boolean(e));
  const ghlError = erroresGhl.length > 0 ? erroresGhl.join(' | ') : null;

  // El `estado` sigue al correo, no a GoHighLevel: restricción global del
  // plan -- "ningún fallo de GoHighLevel invalida una cotización que ya
  // salió al cliente".
  const { error: errorActualizacion } = await supabaseAdmin()
    .from('cotizaciones')
    .update({
      updated_at: new Date().toISOString(),
      contact_id: contactId,
      estado: correoResultado.ok ? 'enviada' : 'error',
      ...(ghl.ok ? { ghl_estimate_id: ghl.estimateId, ghl_error: ghlError } : { ghl_error: ghlError }),
      ...(pdfRuta ? { pdf_ruta: pdfRuta } : {}),
      ...(correoResultado.ok
        ? { enviado_at: new Date().toISOString(), resend_id: correoResultado.resendId, correo_error: null }
        : { correo_error: correoResultado.error }),
    })
    .eq('id', id);

  if (errorActualizacion) {
    console.error(
      '[cotizador] El envío se procesó pero no se pudo actualizar la fila.',
      errorActualizacion.message,
    );
  }

  // "Modificar": la cotización vieja se marca 'reemplazada' recién ACÁ --
  // después de confirmar que la nueva salió de verdad (`correoResultado.ok`)
  // -- nunca antes. Si el correo falla, la vieja queda exactamente como
  // estaba, todavía vigente. El `.in('estado', ESTADOS_MODIFICABLES)` es la
  // guarda atómica contra una carrera: que el estado de la vieja haya
  // cambiado (alguien la cerró en otra pestaña) en el rato entre la
  // validación al recibir la solicitud y este punto -- que para el camino
  // de aprobación puede ser DÍAS, no segundos.
  if (reemplazaId && correoResultado.ok) {
    const { error: errorReemplazo } = await supabaseAdmin()
      .from('cotizaciones')
      .update({
        updated_at: new Date().toISOString(),
        estado: 'reemplazada',
        reemplazada_por: id,
        reemplazada_por_numero: numero,
      })
      .eq('id', reemplazaId)
      .in('estado', ESTADOS_MODIFICABLES);
    if (errorReemplazo) {
      console.error(
        '[cotizador] La cotización nueva salió, pero no se pudo marcar la vieja como reemplazada.',
        errorReemplazo.message,
      );
    }
  }

  return {
    ghl: ghl.ok ? { estimateId: ghl.estimateId } : { error: ghl.error },
    pdf: pdfRuta ? { ruta: pdfRuta } : null,
    correo: correoResultado.ok ? { resendId: correoResultado.resendId } : { error: correoResultado.error },
    correoOk: correoResultado.ok,
  };
}
