import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { rechazar, SIN_PERMISO_APROBAR, type ResultadoRechazar } from '@/lib/cotizador/aprobacion';

export const runtime = 'nodejs';

const Entrada = z.object({
  id: z.uuid('El id de la cotización no es válido.'),
  motivo: z.string().trim().min(1, 'Escribí el motivo del rechazo.').max(500, 'Resumí un poco el motivo.'),
});

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // La credencial (y la autorización, más abajo) se revisan antes que el
  // esquema: mismo motivo que en el resto de app/api/*. Esta ruta escribe
  // (rechaza la cotización): exige el token anti-CSRF.
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = supabaseAdmin();

  // `auth.rol` sale de la cookie y no autoriza nada -- se relee la fila de
  // quien rechaza. Sólo un superadmin puede rechazar un descuento ajeno.
  const autorizacion = await autorizarSuperadmin(auth.id, db);
  if (!autorizacion.ok) {
    return NextResponse.json({ ok: false, error: SIN_PERMISO_APROBAR }, { status: 403 });
  }

  const parseado = Entrada.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }

  let resultado: ResultadoRechazar;
  try {
    resultado = await rechazar(
      db,
      { apiKey: process.env.RESEND_API_KEY ?? '', remitente: process.env.LUXE_CORREO_REMITENTE ?? '' },
      { id: parseado.data.id, aprobador: auth.vendedor, motivo: parseado.data.motivo },
    );
  } catch (err) {
    console.error('[cotizador] Fallo inesperado al rechazar.', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false, error: 'No se pudo rechazar la cotización.' }, { status: 500 });
  }

  if (!resultado.ok) {
    if (resultado.motivo === 'no_encontrado') {
      return NextResponse.json({ ok: false, error: 'Cotización no encontrada.' }, { status: 404 });
    }
    if (resultado.motivo === 'no_pendiente') {
      return NextResponse.json(
        {
          ok: false,
          error: `No se puede rechazar: la cotización ya no está esperando aprobación (estado "${resultado.estadoActual}").`,
        },
        { status: 409 },
      );
    }
    console.error('[cotizador] No se pudo rechazar la cotización.', resultado.error);
    return NextResponse.json({ ok: false, error: 'No se pudo rechazar la cotización.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, numero: resultado.numero, avisoEnviado: resultado.avisoEnviado });
}
