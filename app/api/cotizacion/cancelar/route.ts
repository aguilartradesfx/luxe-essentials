import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { cancelar, type ResultadoCancelar } from '@/lib/cotizador/aprobacion';

export const runtime = 'nodejs';

// Fase 5 (descuento con aprobación): "cancelar" es lo único que el diseño le
// permite hacer al vendedor con una cotización que quedó esperando (no
// puede editarla en el lugar -- ver docs/superpowers/specs/2026-09-02-descuento-aprobacion-design.md).
// A diferencia de /aprobar y /rechazar, esta ruta NO exige superadmin: no
// es una decisión sobre el descuento de otra persona, es retirar la propia
// solicitud -- mismo nivel de acceso que /cerrar y /reenviar en este mismo
// directorio, que cualquier persona autenticada del equipo puede usar sobre
// cualquier fila.
const Entrada = z.object({
  id: z.uuid('El id de la cotización no es válido.'),
});

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // La credencial se revisa antes que el esquema: mismo motivo que en el
  // resto de app/api/cotizacion/*. Esta ruta escribe (cancela la
  // cotización): exige el token anti-CSRF.
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const parseado = Entrada.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }

  let resultado: ResultadoCancelar;
  try {
    resultado = await cancelar(supabaseAdmin(), { id: parseado.data.id });
  } catch (err) {
    console.error('[cotizador] Fallo inesperado al cancelar.', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false, error: 'No se pudo cancelar la solicitud.' }, { status: 500 });
  }

  if (!resultado.ok) {
    if (resultado.motivo === 'no_encontrado') {
      return NextResponse.json({ ok: false, error: 'Cotización no encontrada.' }, { status: 404 });
    }
    if (resultado.motivo === 'no_pendiente') {
      return NextResponse.json(
        {
          ok: false,
          error: `No se puede cancelar: la cotización ya no está esperando aprobación (estado "${resultado.estadoActual}").`,
        },
        { status: 409 },
      );
    }
    console.error('[cotizador] No se pudo cancelar la solicitud de aprobación.', resultado.error);
    return NextResponse.json({ ok: false, error: 'No se pudo cancelar la solicitud.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
