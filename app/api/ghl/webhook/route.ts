import { NextResponse, after } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/server';
import { procesar } from '@/lib/agente/procesar';

export const runtime = 'nodejs';

function secretoValido(recibido: string | null): boolean {
  const esperado = process.env.LUXE_AGENTE_WEBHOOK_SECRET;
  if (!esperado || !recibido) return false;

  // Comparación en tiempo constante. El ataque de temporización sobre HTTP es
  // improbable, pero son tres líneas y evita tener que razonarlo nunca más.
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

// GHL manda el contacto en formas distintas según cómo se configure la acción
// de webhook en el workflow. Se aceptan todas las que aparecen en la práctica.
function contactoDe(cuerpo: unknown): string | null {
  const c = cuerpo as {
    contactId?: unknown; contact_id?: unknown;
    contact?: { id?: unknown }; customData?: { contactId?: unknown };
  };
  const candidato = c?.contactId ?? c?.contact_id ?? c?.contact?.id ?? c?.customData?.contactId;
  return typeof candidato === 'string' && candidato.trim() ? candidato.trim() : null;
}

export async function POST(request: Request) {
  if (!secretoValido(request.headers.get('x-luxe-agente-secreto'))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let cuerpo: unknown;
  try {
    cuerpo = await request.json();
  } catch {
    // 200 y no 400: un cuerpo irreparable no mejora reintentándolo, y un 4xx
    // haría que GHL lo reintentara en bucle.
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const contactId = contactoDe(cuerpo);
  if (!contactId) {
    console.error('[agente] Webhook sin contactId; no hay nada que procesar.');
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // El pipeline completo tarda entre 5 y 20 segundos. GHL reintenta lo que
  // tarda, y un reintento son dos respuestas al mismo cliente, así que se
  // responde ya y el trabajo sigue en segundo plano.
  after(async () => {
    try {
      const resultado = await procesar(contactId, {
        db: supabaseAdmin(),
        ghlApiKey: process.env.LUXE_GHL_API_KEY ?? '',
        locationId: process.env.LUXE_GHL_LOCATION_ID ?? '',
        anthropicKey: process.env.LUXE_ANTHROPIC_API_KEY ?? '',
        openaiKey: process.env.LUXE_OPENAI_API_KEY ?? '',
      });
      if (resultado.desenlace === 'error') {
        console.error('[agente] Turno abandonado.', 'contacto:', contactId, resultado.detalle);
      }
    } catch (err) {
      // Nada de lo que ocurra aquí puede propagarse: la respuesta HTTP ya salió.
      console.error('[agente] Fallo inesperado en el trabajo diferido.', 'contacto:', contactId, err);
    }
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
