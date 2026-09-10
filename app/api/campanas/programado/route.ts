import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { estadoProgramado } from '@/lib/campanas/programado';

export const runtime = 'nodejs';

// El interruptor del envío programado (encargo, punto 6): lo que
// VistaHistorialCampanas.tsx lee para mostrar, siempre a la vista, si el
// cron está activo o pausado -- y por quién y cuándo, si está pausado.
// Ruta de sólo lectura: no exige el token anti-CSRF, mismo criterio que
// /api/campanas/zonas y /api/campanas/plantillas.
//
// Mismo criterio de autorización que el resto de app/api/campanas/* -- ver
// el comentario grande en app/api/campanas/zonas/route.ts.
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
    return NextResponse.json({ ok: false, error: 'No tenés permiso para ver el envio programado.' }, { status: 403 });
  }

  let estado;
  try {
    estado = await estadoProgramado(db);
  } catch (err) {
    console.error('[campanas] No se pudo leer el estado del envio programado.', err);
    return NextResponse.json({ ok: false, error: 'No se pudo leer el estado del envio programado.' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    pausado: estado.pausado,
    pausadoPor: estado.pausadoPor,
    pausadoAt: estado.pausadoAt,
  });
}
