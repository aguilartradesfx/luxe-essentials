import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { listarCampanas } from '@/lib/campanas/progreso';

export const runtime = 'nodejs';

// Bandeja de campañas (parte 2): el historial de campañas, con el progreso
// de cada una. Es lo que hace visible "quedó una campaña a medias" cuando
// se cierra la pestaña a mitad de un envío y se vuelve más tarde -- el
// registro por destinatario ya existe del lado del servidor desde que se
// creó la campaña (`campanas_envios`, migración 0019); esta ruta es lo
// único que lo saca a la luz.
//
// Mismo criterio de autorización que el resto de app/api/campanas/* -- ver
// el comentario grande en app/api/campanas/zonas/route.ts. Ruta de sólo
// lectura: no exige el token anti-CSRF.
export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  const auth = await autenticarPeticion(request, crudo, { requiereCsrf: false });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = supabaseAdmin();
  const autorizacion = await autorizarSuperadmin(auth.id, db);
  if (!autorizacion.ok) {
    return NextResponse.json({ ok: false, error: 'No tenés permiso para ver campañas.' }, { status: 403 });
  }

  try {
    const campanas = await listarCampanas(db);
    return NextResponse.json({ ok: true, campanas });
  } catch (err) {
    console.error('[campanas] No se pudo listar las campañas.', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false, error: 'No se pudo consultar las campañas.' }, { status: 500 });
  }
}
