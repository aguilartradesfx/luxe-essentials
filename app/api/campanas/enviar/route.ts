import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { enviarTanda } from '@/lib/campanas/envio';

export const runtime = 'nodejs';

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

  const auth = autenticarPeticion(request, crudo, { requiereCsrf: true });
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

  const deps = {
    resendApiKey: process.env.RESEND_API_KEY ?? '',
    remitente: process.env.LUXE_CORREO_REMITENTE ?? '',
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
