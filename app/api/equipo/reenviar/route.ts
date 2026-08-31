import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin, reenviarInvitacion } from '@/lib/cotizador/equipo';

export const runtime = 'nodejs';

const SIN_PERMISO = 'No tenés permiso para administrar el equipo.';

const Entrada = z.object({
  id: z.uuid('El id no es válido.'),
});

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // Esta ruta escribe (genera un enlace nuevo y lo guarda): exige el token
  // anti-CSRF, igual que /invitar y /estado.
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = supabaseAdmin();

  const autorizacion = await autorizarSuperadmin(auth.vendedor, db);
  if (!autorizacion.ok) {
    return NextResponse.json({ ok: false, error: SIN_PERMISO }, { status: 403 });
  }

  const parseado = Entrada.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }

  const resultado = await reenviarInvitacion(
    db,
    { apiKey: process.env.RESEND_API_KEY ?? '', remitente: process.env.LUXE_CORREO_REMITENTE ?? '' },
    parseado.data.id,
  );

  if (!resultado.ok) {
    if (resultado.motivo === 'no_encontrado') {
      return NextResponse.json({ ok: false, error: 'Esa persona no está en el equipo.' }, { status: 404 });
    }
    if (resultado.motivo === 'ya_activo') {
      return NextResponse.json(
        { ok: false, error: 'Esa persona ya entró: no hay ninguna invitación pendiente para reenviar.' },
        { status: 400 },
      );
    }
    console.error('[cotizador] No se pudo reenviar la invitación.', resultado.error);
    return NextResponse.json({ ok: false, error: 'No se pudo reenviar la invitación.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, correoEnviado: resultado.correoEnviado });
}
