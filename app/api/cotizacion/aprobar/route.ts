import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { aprobar, SIN_PERMISO_APROBAR, type ResultadoAprobar } from '@/lib/cotizador/aprobacion';
import { descuentoPersonalizadoSchema } from '@/lib/validation';

export const runtime = 'nodejs';

// Mismo motivo que app/api/cotizacion/route.ts: aprobar corre exactamente
// la misma cadena pesada (Estimate/Opportunity en GoHighLevel, PDF, correo
// con adjunto, nota) a través de `enviarCotizacionAlHotel`
// (lib/cotizador/enviar.ts). Sin esto correría con el límite por defecto de
// Vercel (10 s), corto de sobra para esa cadena.
export const maxDuration = 60;

const Entrada = z.object({
  id: z.uuid('El id de la cotización no es válido.'),
  // Si el superadmin cambia el porcentaje antes de aprobar. Mismo esquema
  // que ya valida el descuento al pedirlo (lib/validation.ts): el borde
  // real es el mismo, un número que llega del navegador no se confía más
  // acá que allá.
  descuentoPersonalizado: descuentoPersonalizadoSchema.optional(),
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
  // (aprueba y envía): exige el token anti-CSRF.
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = supabaseAdmin();

  // `auth.rol` sale de la cookie y no autoriza nada -- se relee la fila de
  // quien aprueba. Sólo un superadmin puede aprobar un descuento ajeno.
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

  let resultado: ResultadoAprobar;
  try {
    resultado = await aprobar(
      db,
      { apiKey: process.env.RESEND_API_KEY ?? '', remitente: process.env.LUXE_CORREO_REMITENTE ?? '' },
      {
        id: parseado.data.id,
        aprobador: auth.vendedor,
        nuevoDescuento: parseado.data.descuentoPersonalizado,
      },
    );
  } catch (err) {
    console.error('[cotizador] Fallo inesperado al aprobar.', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false, error: 'No se pudo aprobar la cotización.' }, { status: 500 });
  }

  if (!resultado.ok) {
    if (resultado.motivo === 'no_encontrado') {
      return NextResponse.json({ ok: false, error: 'Cotización no encontrada.' }, { status: 404 });
    }
    // No alcanza con confiar en lo que manda el navegador: si la fila ya no
    // está esperando (aprobada/rechazada/cancelada por otra persona, o en
    // disputa con otra aprobación concurrente), se rechaza acá con un
    // mensaje que dice el estado real.
    if (resultado.motivo === 'no_pendiente') {
      return NextResponse.json(
        {
          ok: false,
          error: `No se puede aprobar: la cotización ya no está esperando aprobación (estado "${resultado.estadoActual}").`,
        },
        { status: 409 },
      );
    }
    console.error('[cotizador] No se pudo aprobar la cotización.', resultado.error);
    return NextResponse.json({ ok: false, error: 'No se pudo aprobar la cotización.' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    numero: resultado.numero,
    estado: resultado.estadoFinal,
    cambioPorcentaje: resultado.cambioPorcentaje,
    avisoEnviado: resultado.avisoEnviado,
  });
}
