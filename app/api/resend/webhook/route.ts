import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/server';
import { firmaSvixValida, leerEventoResend, registrarEventoResend } from '@/lib/campanas/entrega';

export const runtime = 'nodejs';

// El webhook de Resend: entregado, rebotó, queja, abierto... de cada correo
// que salió (ver lib/campanas/entrega.ts y la migración 0029).
//
// RÁPIDA a propósito: Resend (Svix) reintenta lo que tarda. Todo el trabajo
// es verificar la firma y UNA llamada a la base (rpc atómico) -- sin
// `after()`, sin GHL, sin nada pesado. Por eso no hace falta ampliar
// `maxDuration`.
//
// Códigos de respuesta, pensados para el reintento de Svix:
//   500 sin RESEND_WEBHOOK_SECRET -- FALLA CERRADA, igual que el cron
//       (app/api/campanas/cron/route.ts): sin secreto no se acepta nada.
//   401 firma inválida o marca de tiempo vieja -- reintentar no la arregla.
//   200 evento que no nos sirve (otro tipo, JSON roto): reintentarlo no
//       mejora nada (mismo criterio que app/api/ghl/webhook/route.ts).
//   200 evento de un correo que no es de campaña (cotización, invitación):
//       se guarda en el rastro y no revienta.
//   500 si la base falla: SÍ conviene que Svix reintente -- y es seguro
//       porque el `svix-id` hace idempotente cada intento.
export async function POST(request: Request) {
  const secreto = process.env.RESEND_WEBHOOK_SECRET;
  if (!secreto) {
    console.error('[resend] Falta RESEND_WEBHOOK_SECRET en el entorno: el webhook no acepta nada hasta que se configure.');
    return NextResponse.json({ ok: false, error: 'Falta configurar RESEND_WEBHOOK_SECRET.' }, { status: 500 });
  }

  // El cuerpo CRUDO: la firma se calcula sobre los bytes exactos que llegaron.
  const cuerpo = await request.text();
  const id = request.headers.get('svix-id');
  const timestamp = request.headers.get('svix-timestamp');

  if (!firmaSvixValida({ id, timestamp, firma: request.headers.get('svix-signature'), cuerpo, secreto })) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const evento = leerEventoResend(cuerpo, Number(timestamp));
  if (!evento) {
    return NextResponse.json({ ok: true, ignorado: true }, { status: 200 });
  }

  try {
    const resultado = await registrarEventoResend(supabaseAdmin(), id as string, evento);
    return NextResponse.json({ ok: true, resultado }, { status: 200 });
  } catch (err) {
    console.error('[resend] No se pudo registrar el evento.', evento.tipo, err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
