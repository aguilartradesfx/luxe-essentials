import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { todasLasPlantillas } from '@/lib/campanas/plantillas';
import { extraerParrafosEditables } from '@/lib/campanas/edicion';

export const runtime = 'nodejs';

// Bandeja de campañas (parte 2): las cuatro plantillas, con su asunto, su
// vista previa y los párrafos de cuerpo YA separados para el editor -- el
// `html` completo (con las tablas, el botón, la firma) nunca sale hacia
// acá; el navegador no necesita verlo ni puede tocarlo (`aplicarParrafosEditados`
// vive del lado del servidor, en las rutas /crear y /previsualizar).
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

  const auth = autenticarPeticion(request, crudo, { requiereCsrf: false });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = supabaseAdmin();
  const autorizacion = await autorizarSuperadmin(auth.id, db);
  if (!autorizacion.ok) {
    return NextResponse.json({ ok: false, error: 'No tenés permiso para ver campañas.' }, { status: 403 });
  }

  const plantillas = todasLasPlantillas().map((p) => ({
    plantilla: p.plantilla,
    asunto: p.asunto,
    previewText: p.previewText,
    parrafos: extraerParrafosEditables(p.html).map((x) => x.texto),
  }));

  return NextResponse.json({ ok: true, plantillas });
}
