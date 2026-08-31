import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin, listarEquipo } from '@/lib/cotizador/equipo';

export const runtime = 'nodejs';

// Mismo texto en las cuatro rutas de este directorio: quien no es
// superadmin (de verdad, releído de la base — ver `autorizarSuperadmin`)
// recibe siempre este mensaje, nunca uno distinto según la ruta.
const SIN_PERMISO = 'No tenés permiso para administrar el equipo.';

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // Ruta de solo lectura (SELECT): no exige el token anti-CSRF, igual que
  // /api/cotizacion/catalogo y /borradores.
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: false });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = supabaseAdmin();

  // `auth.rol` sale de la cookie y no autoriza nada (lib/autenticacion-cotizador.ts).
  // `autorizarSuperadmin` relee la fila de quien hace la petición antes de
  // dejarlo ver el equipo entero, incluidas cuentas ajenas.
  const autorizacion = await autorizarSuperadmin(auth.vendedor, db);
  if (!autorizacion.ok) {
    return NextResponse.json({ ok: false, error: SIN_PERMISO }, { status: 403 });
  }

  try {
    const equipo = await listarEquipo(db);
    return NextResponse.json({ ok: true, equipo });
  } catch (err) {
    console.error('[cotizador] No se pudo listar el equipo.', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false, error: 'No se pudo consultar el equipo.' }, { status: 500 });
  }
}
