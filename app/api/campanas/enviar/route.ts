import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { enviarTanda, TAMANO_TANDA } from '@/lib/campanas/envio';
import { progresoCampana } from '@/lib/campanas/progreso';
import { reservarCupoDiario } from '@/lib/campanas/programado';

export const runtime = 'nodejs';

// Hallazgo importante (revisión final, punto 1): esta era la única ruta
// pesada de app/api/campanas/* sin `maxDuration` -- mismo criterio, exacto,
// que ya explica app/api/cotizacion/route.ts: sin esto la función corre con
// el límite por defecto de Vercel (10 s), corto de sobra para una tanda que
// hace un rpc de reclamo, una llamada de LOTE a Resend con hasta cien
// destinatarios, y el rpc de cierre (migración 0023) -- y si esa llamada de
// Resend en particular tarda (no es infrecuente con lotes grandes), un
// corte a los 10s dejaría la reserva de esos cien 'pendiente' hasta que
// venza sola. `enviarTanda` ya es retomable ante eso (por diseño), pero no
// hay motivo para regalarle ese riesgo a cada tanda cuando alcanza con
// declarar el mismo límite que el resto de las rutas que hacen trabajo real
// contra un servicio externo.
export const maxDuration = 60;

const Entrada = z.object({ campanaId: z.string().min(1, 'Falta el id de la campaña.') });

// Bandeja de campañas (parte 2): manda UNA tanda (hasta 100 destinatarios,
// `TAMANO_TANDA` en lib/campanas/envio.ts) de una campaña ya creada. La
// pantalla la llama repetidas veces -- al enviar por primera vez, y al
// "retomar" una campaña interrumpida -- hasta que la respuesta trae
// `terminada: true`. Cada llamada es independiente: no hace falta ningún
// cursor, porque `enviarTanda` ya sabe, por `campanas_envios`, por dónde
// va (ver el comentario grande de esa función).
//
// La ruta que manda correo real: exige el token anti-CSRF, igual que
// /crear. Mismo criterio de autorización que el resto de
// app/api/campanas/* -- ver el comentario grande en
// app/api/campanas/zonas/route.ts. Acá pesa más que en ninguna otra: ésta
// es la única ruta de las siete que de verdad hace algo irreversible.
export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  const auth = await autenticarPeticion(request, crudo, { requiereCsrf: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = supabaseAdmin();
  const autorizacion = await autorizarSuperadmin(auth.id, db);
  if (!autorizacion.ok) {
    return NextResponse.json({ ok: false, error: 'No tenés permiso para enviar campañas.' }, { status: 403 });
  }

  const parseado = Entrada.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }

  // El cupo diario -- guardia nueva (hallazgo de producción, 2026-09-10):
  // ANTES esta ruta no miraba el cupo para nada. Un "Retomar" sobre una
  // campaña `programada` (armada por el cron, ver lib/campanas/programado.ts)
  // podía mandar de un tirón lo que la rampa de calentamiento reparte en
  // semanas -- exactamente el mecanismo que existe para que Gmail no
  // marque el dominio, el mismo por el que salen las cotizaciones a los
  // hoteles. Quitarle el botón "Retomar" a una campaña programada en la
  // pantalla (VistaHistorialCampanas.tsx) no alcanza -- una pestaña vieja,
  // o alguien llamando esta ruta directo, se saltan un botón que ya no
  // está. La guardia real tiene que vivir ACÁ.
  //
  // Corre para TODA campaña, programada o no -- a propósito, sin mirar la
  // columna `programada`: el pedido no es sólo "que una campaña programada
  // respete SU cupo", es que NINGUNA campaña -- tampoco una armada a mano
  // -- empuje el total del día más allá del tope diario de Resend (el
  // límite del plan, 100/día, para TODA la cuenta -- cotizaciones
  // incluidas). Pasarse de ese tope no manda más correos: Resend rechaza
  // el resto y queda marcado 'error', peor que no mandarlo. Reservando acá
  // con la MISMA función que ya usa el cron (`reservarCupoDiario`,
  // lib/campanas/programado.ts) -- el mismo registro diario
  // (`campanas_envio_diario`) y el mismo cálculo de rampa, que nunca pasa
  // de 100 -- una campaña manual queda automáticamente acotada por lo que
  // le sobre al día después de lo que ya reservó el cron, sin que haga
  // falta un segundo criterio aparte que pueda desincronizarse del
  // primero.
  //
  // El cron (`ejecutarEnvioProgramado`) NO pasa por esta ruta -- llama a
  // `enviarTanda` directo y reserva su propio cupo antes -- así que esto no
  // lo hace reservar dos veces.
  let progreso;
  try {
    progreso = await progresoCampana(db, parseado.data.campanaId);
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    console.error('[campanas] No se pudo leer el progreso antes de reservar cupo.', parseado.data.campanaId, mensaje);
    return NextResponse.json({ ok: false, error: mensaje }, { status: 502 });
  }

  // Una campaña ya cancelada no reserva cupo -- `enviarTanda` la corta
  // apenas la lee y no manda nada de todas formas (ver el comentario
  // grande de esa función), así que reservar acá sería gastar el cupo del
  // día en algo que nunca se va a mandar, quitándoselo a una campaña que
  // sí siga en curso.
  let cancelada = false;
  try {
    const { data: campanaFila, error: errorCampana } = await db
      .from('campanas')
      .select('cancelada_at')
      .eq('id', parseado.data.campanaId)
      .maybeSingle();
    if (errorCampana) throw new Error(errorCampana.message);
    cancelada = Boolean((campanaFila as { cancelada_at: string | null } | null)?.cancelada_at);
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    console.error('[campanas] No se pudo leer la campaña antes de reservar cupo.', parseado.data.campanaId, mensaje);
    return NextResponse.json({ ok: false, error: mensaje }, { status: 502 });
  }

  let limiteTanda: number | undefined;
  if (progreso.pendientes > 0 && !cancelada) {
    const fechaHoy = new Date().toISOString().slice(0, 10);
    const solicitado = Math.min(progreso.pendientes, TAMANO_TANDA);
    let cupo: number;
    try {
      cupo = await reservarCupoDiario(db, fechaHoy, solicitado);
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      console.error('[campanas] No se pudo reservar el cupo diario.', parseado.data.campanaId, mensaje);
      return NextResponse.json({ ok: false, error: mensaje }, { status: 502 });
    }
    if (cupo <= 0) {
      // 409, no 502: no es un fallo del servidor -- es una regla de
      // negocio que se está respetando a propósito. La campaña queda
      // exactamente donde iba (nada se reservó, nada se mandó); se puede
      // reintentar mañana, o solo (envío programado) o a mano.
      return NextResponse.json(
        {
          ok: false,
          error:
            'No queda cupo de envío para hoy (tope diario de Resend). Esta campaña sigue donde iba -- se puede retomar mañana.',
        },
        { status: 409 },
      );
    }
    // Sólo se acota `enviarTanda` cuando el cupo reservado quedó CORTO de
    // lo pedido -- si cubrió el pedido entero (`cupo === solicitado`), se
    // deja que `enviarTanda` use su propio tope por defecto (`TAMANO_TANDA`).
    // Sin este `if`, pasarle un límite que coincide EXACTO con lo pendiente
    // dispara el caso que ya documenta el comentario de `terminada` en
    // lib/campanas/envio.ts ("con un límite acotado por el cupo... puede
    // dar `false` aunque la campaña ya no tenga MÁS pendientes"): la
    // pantalla vería "sigue enviando" por una vuelta de más aunque ya
    // estuviera terminada. El cron (`ejecutarEnvioProgramado`) no le
    // importa esto -- dispara una tanda por invocación y no mira
    // `terminada` en un bucle -- pero el "Retomar" de esta ruta sí lo
    // recorre hasta que llega `true`, así que acá sí vale la pena la
    // distinción.
    if (cupo < solicitado) limiteTanda = cupo;
  }

  const deps = {
    resendApiKey: process.env.RESEND_API_KEY ?? '',
    remitente: process.env.LUXE_CORREO_REMITENTE ?? '',
    limiteTanda,
  };

  const resultado = await enviarTanda(parseado.data.campanaId, deps, db);
  if (!resultado.ok) {
    console.error('[campanas] No se pudo enviar una tanda.', parseado.data.campanaId, resultado.error);
    return NextResponse.json({ ok: false, error: resultado.error }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    procesados: resultado.procesados,
    enviados: resultado.enviados,
    fallidos: resultado.fallidos,
    terminada: resultado.terminada,
    // Sólo va en el cuerpo (`JSON.stringify` descarta un `undefined`) cuando
    // esta tanda encontró la campaña ya cancelada -- ver el comentario de
    // `ResultadoTanda` en lib/campanas/envio.ts.
    cancelada: resultado.cancelada,
  });
}
