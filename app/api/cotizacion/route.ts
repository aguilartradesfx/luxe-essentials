import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { cotizacionSchema } from '@/lib/validation';
import { calcular } from '@/lib/cotizador/calcular';
import { CATALOGO } from '@/lib/cotizador/catalogo';
import { crearEstimate, notaDeCotizacion } from '@/lib/cotizador/ghl';
import { agregarNota } from '@/lib/agente/acciones';
import { renderizarCotizacion } from '@/lib/cotizador/documento';
import { guardarPdf, enlaceFirmado } from '@/lib/cotizador/almacen';
import { enviarCotizacion } from '@/lib/cotizador/correo';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// Ronda de correcciones final (hallazgo importante): es la única ruta de
// app/api/cotizacion/* que escribe sin declarar `maxDuration` — y la que más
// tiempo puede tomar: insert, hasta cuatro llamadas HTTP a GoHighLevel,
// render del PDF, subida a Storage, firma del enlace, correo con adjunto por
// Resend y nota en el contacto, antes del update final. Sin esto, la función
// corre con el límite por defecto de Vercel (10 s) — corto de sobra para esa
// cadena — y si expira a mitad, la fila queda parada en 'borrador': no
// aparece en fallidas (esas son 'error'), `/cerrar` la rechaza (no está en
// `ESTADOS_CIERRE_INICIAL`) y `/reenviar` también (no tiene `pdf_ruta`). Un
// huérfano sin salida. Mismo criterio que app/api/ghl/webhook/route.ts, que
// enfrenta el mismo problema con una cadena de llamadas de red parecida.
export const maxDuration = 60;

// Mismo valor que `DIAS_VIGENCIA` en lib/cotizador/ghl.ts (no exportado de
// ahí, se duplica acá por la misma razón que las notas de documento.tsx/
// correo.ts): cuántos días queda vigente el precio cotizado. El PDF y el
// correo tienen que decir la misma fecha que el Estimate de GoHighLevel.
const DIAS_VIGENCIA = 30;

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // La credencial se revisa antes que el esquema: si alguien sin ella manda
  // un cuerpo mal formado, no debe recibir mensajes de validación que
  // revelen la forma esperada del cuerpo. Mismo orden que app/api/q7m4/route.ts.
  // Esta ruta escribe (inserta la cotización): `requiereCsrf: true` exige el
  // token anti-CSRF cuando se entra por cookie (ver lib/autenticacion-cotizador.ts).
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const parseado = cotizacionSchema.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }
  const datos = parseado.data;

  // `calcular` lanza si un SKU no existe o la cantidad es absurda. Eso es un
  // error del cliente, no del servidor: se traduce a 400 en vez de dejar que
  // reviente en 500.
  let cotizacion;
  try {
    cotizacion = calcular(datos.lineas, CATALOGO, {
      tasaIva: datos.tasaIva,
      bordadoEspecial: datos.bordadoEspecial,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'No se pudo calcular.' },
      { status: 400 },
    );
  }

  // Primero la base, después GoHighLevel (Tarea 7). Si el CRM falla, la
  // cotización sigue existiendo y es recuperable; al revés, el cliente tendría
  // una cotización que Luxe no registró.
  const { data, error } = await supabaseAdmin()
    .from('cotizaciones')
    .insert({
      // Ronda de correcciones final (hallazgo crítico): antes esto era
      // siempre 'humano', incluso cuando `datos.borradorId` probaba que la
      // cotización nació de un borrador que dejó el agente de WhatsApp. Como
      // esas filas quedan en 'convertida' (ver el update de abajo) y
      // `calcularMetricas` (lib/cotizador/metricas.ts) excluye ese estado de
      // todo, `porOrigen.agente` salía en cero siempre — la métrica de
      // "Origen" (Métricas #6) le decía al vendedor que el agente no aporta
      // nada, aunque toda la cotización viniera de él.
      origen: datos.borradorId ? 'agente' : 'humano',
      estado: 'borrador',
      cliente: datos.cliente,
      lineas: cotizacion.lineas,
      totales: {
        subtotal: cotizacion.subtotal,
        ahorro: cotizacion.ahorro,
        tasaIva: cotizacion.tasaIva,
        iva: cotizacion.iva,
        total: cotizacion.total,
        // Sin columna propia: viaja dentro del jsonb para que la Tarea 7 sepa
        // si el Estimate debe llevar la nota de "precio a confirmar contra
        // muestra". Sin esto, reimprimir la cotización meses después perdería
        // esa condición y el documento parecería un precio en firme que
        // nunca lo fue.
        bordadoEspecial: cotizacion.bordadoEspecial,
      },
    })
    .select()
    .single();

  if (error) {
    console.error('[cotizador] No se pudo guardar la cotización.', error.message);
    return NextResponse.json({ ok: false, error: 'No se pudo guardar.' }, { status: 500 });
  }

  // Ronda de correcciones 2 (hallazgo I1): si esta cotización nació de un
  // borrador que dejó el agente de IA, esa fila hay que cerrarla ya —
  // independiente de cómo le vaya a GoHighLevel más abajo. La cotización
  // real (esta que se acaba de guardar) ya existe: dejar el borrador en
  // 'borrador' para siempre es lo que hoy nunca vacía la cola del vendedor
  // y, peor, bloquea `registrarIntencion` (lib/cotizador/borrador.ts) para
  // este contacto de por vida, porque esa función corta si ya hay un
  // 'borrador' abierto suyo. Best-effort: un fallo acá se registra pero no
  // debe tumbar la respuesta, la cotización ya está a salvo.
  if (datos.borradorId) {
    const { error: errorBorrador } = await supabaseAdmin()
      .from('cotizaciones')
      .update({ estado: 'convertida', updated_at: new Date().toISOString() })
      .eq('id', datos.borradorId);
    if (errorBorrador) {
      console.error('[cotizador] No se pudo cerrar el borrador del agente.', errorBorrador.message);
    }
  }

  // GoHighLevel primero (Tarea 7), fuera del camino crítico del envío real
  // al cliente. Ronda de correcciones 1 (Tarea 5): antes esta llamada corría
  // DESPUÉS de mandar el correo — hasta cuatro peticiones HTTP a GoHighLevel,
  // sin `AbortSignal` ni timeout propio, entre "el hotel ya tiene el PDF" y
  // "la fila quedó registrada". Si `crearEstimate` se colgaba y la función
  // expiraba (la ruta no declara `maxDuration`), el único `update` de abajo
  // nunca corría: la fila se quedaba en 'borrador', sin `pdf_ruta` ni
  // `resend_id`, candidata a que algún reintento futuro reenviara al hotel
  // una cotización que ya recibió. Moviendo GoHighLevel antes, un colgado
  // ahí ya no puede tumbar el registro de un correo que sí salió.
  const ghl = await crearEstimate(
    { cotizacion, cliente: datos.cliente, contactId: datos.contactId },
    {
      apiKey: process.env.LUXE_GHL_API_KEY ?? '',
      locationId: process.env.LUXE_GHL_LOCATION_ID ?? '',
    },
  );

  // El contactId se guarda aunque GoHighLevel haya fallado después: si el
  // contacto se llegó a resolver (recibido del vendedor, o recién creado por
  // `crearEstimate`), es un dato gratis que ya tenemos en la mano y que de
  // otro modo se pierde sin dejar rastro en la fila.
  const contactId = ghl.contactId ?? datos.contactId ?? null;

  // El `numero` no lo asigna este código: lo pone un trigger en la base
  // (migración 0010, `cotizaciones_asignar_numero` / `obtener_numero_cotizacion`)
  // al momento del insert, correlativo por año ("COT-2026-0001", "-0002"…).
  // El insert de arriba ya hizo `.select().single()`, así que `data.numero`
  // vuelve con el valor puesto, sin una consulta extra. No se deriva del
  // `id`: un UUID en el documento que recibe un hotel no es un número de
  // cotización.
  const numero: string = data.numero;

  const emitida = new Date();
  const vence = new Date(emitida);
  vence.setDate(vence.getDate() + DIAS_VIGENCIA);

  // Enriquecimiento (Tarea 5): la fila ya existe desde el insert de arriba,
  // así que nada de lo que sigue puede perderla — a lo peor queda marcada
  // 'error' y recuperable a mano. `renderizarCotizacion` es la única pieza
  // nueva que sí puede lanzar (guardarPdf/enlaceFirmado/enviarCotizacion
  // nunca lo hacen), por eso va envuelta en try/catch.
  let pdfBuffer: Buffer | null = null;
  try {
    pdfBuffer = await renderizarCotizacion({ numero, cotizacion, cliente: datos.cliente, emitida, vence });
  } catch (err) {
    console.error(
      '[cotizador] No se pudo generar el PDF de la cotización.',
      err instanceof Error ? err.message : String(err),
    );
  }

  let pdfRuta: string | null = null;
  // Enlace firmado del PDF, para el correo y (más abajo) para la nota de
  // GoHighLevel. Se queda vacío si no se llegó a firmar o nunca se guardó.
  let enlacePdf = '';
  // Regla que no se negocia: si no hay PDF, no se manda un correo que diga
  // "le adjunto la cotización" sin adjunto — eso es peor que no mandar nada.
  let correoResultado: { ok: true; resendId: string } | { ok: false; error: string } = {
    ok: false,
    error: 'No se generó el PDF: no se intentó enviar el correo.',
  };

  if (pdfBuffer) {
    const guardado = await guardarPdf({ id: data.id, numero, pdf: pdfBuffer }, supabaseAdmin());
    if (!guardado.ok) {
      console.error('[cotizador] No se pudo guardar el PDF en el almacenamiento.', guardado.error);
      correoResultado = { ok: false, error: guardado.error };
    } else {
      pdfRuta = guardado.ruta;
      const firmado = await enlaceFirmado(guardado.ruta, supabaseAdmin());
      if (!firmado.ok) {
        console.error('[cotizador] No se pudo firmar el enlace del PDF.', firmado.error);
      }
      // El adjunto es lo que de verdad importa; sin enlace firmado el correo
      // igual sale, solo que `cuerpoHtml` (lib/cotizador/correo.ts) omite el
      // párrafo del enlace en vez de mandar uno vacío.
      enlacePdf = firmado.ok ? firmado.url : '';
      correoResultado = await enviarCotizacion(
        {
          numero,
          cliente: datos.cliente,
          total: cotizacion.total,
          vence,
          pdf: pdfBuffer,
          enlace: enlacePdf,
        },
        {
          apiKey: process.env.RESEND_API_KEY ?? '',
          remitente: process.env.LUXE_CORREO_REMITENTE ?? '',
        },
      );
    }
  }

  // Tarea 12 — la nota en el contacto de GoHighLevel: el correo con el PDF
  // sale por Resend, por fuera del CRM, así que sin esto la conversación del
  // contacto no muestra nada y el equipo comercial no tiene forma de saber
  // que a este hotel ya se le cotizó. Sólo se agrega cuando el correo salió
  // de verdad (si no salió, no hay nada que trazar) y hay un contacto al que
  // anotarle algo.
  //
  // Ronda de correcciones 1: los dos posibles fallos de acá abajo NO son lo
  // mismo y se registran distinto.
  //
  // - `notaDeCotizacion` es pura, local y síncrona: NUNCA debería lanzar. Si
  //   lo hace, es un bug de este código (no un fallo de GoHighLevel), y se
  //   registra como tal — con la palabra "BUG" — para que no se confunda con
  //   una caída real de la API. No se junta a `ghl_error`: no tiene nada que
  //   ver con GoHighLevel.
  // - `agregarNota` (lib/agente/acciones.ts) ya nunca lanza por diseño:
  //   siempre resuelve, devolviendo el error como valor. Ese error sí es un
  //   fallo tolerable ("GoHighLevel está caído") y se junta al `ghl_error`
  //   de más abajo, junto al resto de lo que le pasó a GoHighLevel con esta
  //   cotización.
  //
  // Ninguno de los dos casos invalida la cotización — el correo ya llegó al
  // hotel.
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

  // El registro ya existe pase lo que pase. Un solo update junta cómo le fue
  // a GoHighLevel (Tarea 7) y cómo le fue al envío real al cliente (PDF +
  // correo, Tarea 5). El `estado` sigue al correo, no a GoHighLevel:
  // restricción global del plan — "ningún fallo de GoHighLevel invalida una
  // cotización que ya salió al cliente". 'enviada' ahora es real: antes
  // (rondas de correcciones 1 y 2) se quedaba en 'creada' porque
  // `crearEstimate` nunca llama al envío de GoHighLevel; el envío real es
  // este correo con el PDF de Luxe adjunto.
  // Junta el error de la Opportunity/Estimate (si lo hubo) con el de la nota
  // (si lo hubo): las dos cosas son "algo le pasó a GoHighLevel con esta
  // cotización" y comparten la misma columna. Ninguna de las dos baja el
  // `estado` — ver el comentario grande de arriba sobre por qué el estado
  // sigue al correo, no a GoHighLevel.
  const erroresGhl = [ghl.ok ? ghl.opportunityError : ghl.error, notaError].filter(
    (e): e is string => Boolean(e),
  );
  const ghlError = erroresGhl.length > 0 ? erroresGhl.join(' | ') : null;

  const { error: errorActualizacion } = await supabaseAdmin()
    .from('cotizaciones')
    .update({
      // `updated_at` va explícito: la columna tiene `default now()` pero no
      // hay trigger, así que sin esto se quedaría siempre igual a
      // `created_at` y la auditoría diría que la cotización nunca cambió de
      // estado.
      updated_at: new Date().toISOString(),
      contact_id: contactId,
      estado: correoResultado.ok ? 'enviada' : 'error',
      ...(ghl.ok ? { ghl_estimate_id: ghl.estimateId, ghl_error: ghlError } : { ghl_error: ghlError }),
      ...(pdfRuta ? { pdf_ruta: pdfRuta } : {}),
      ...(correoResultado.ok
        ? { enviado_at: new Date().toISOString(), resend_id: correoResultado.resendId, correo_error: null }
        // Ronda de correcciones final (hallazgo importante): el diseño
        // promete "las que fallaron, con su error" (ver la vista de
        // fallidas) — pero el error del correo nunca se guardaba en ningún
        // lado. `correoResultado.error` cubre las tres formas de fallar de
        // arriba: sin PDF (falló `renderizarCotizacion`), sin guardar (falló
        // `guardarPdf`) y sin enviar (falló `enviarCotizacion` — p. ej. sin
        // RESEND_API_KEY configurada, el caso de hoy).
        : { correo_error: correoResultado.error }),
    })
    .eq('id', data.id);

  if (errorActualizacion) {
    // El Estimate (y la Opportunity), el PDF y el correo ya se gestionaron
    // en este punto — esto no invalida ese resultado. Pero si esto falla en
    // silencio, la fila queda parada en 'borrador' sin nada de lo de arriba
    // pese a que sí existe: el mismo huérfano que "primero Supabase" evita,
    // corrido un paso más adelante. Se registra para que sea recuperable a
    // mano.
    console.error(
      '[cotizador] El envío se procesó pero no se pudo actualizar la fila.',
      errorActualizacion.message,
    );
  }

  return NextResponse.json({
    ok: true,
    id: data.id,
    numero,
    cotizacion,
    ghl: ghl.ok ? { estimateId: ghl.estimateId } : { error: ghl.error },
    pdf: pdfRuta ? { ruta: pdfRuta } : null,
    correo: correoResultado.ok ? { resendId: correoResultado.resendId } : { error: correoResultado.error },
  });
}
