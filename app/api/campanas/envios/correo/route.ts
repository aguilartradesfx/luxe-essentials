import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { esUuid } from '@/lib/campanas/envios-listado';
import { leerCorreoEnviado } from '@/lib/campanas/envio-correo';

export const runtime = 'nodejs';

// El correo que recibió UNA persona (ventana de «Correos enviados»). Aparte
// del listado para que el cuerpo -- ~10 KB -- sólo viaje cuando alguien abre
// la ventana. Trae nombres, correos y el enlace de baja de un cliente real:
// mismo criterio de autorización que el resto de app/api/campanas/* -- se
// relee la fila de quien pide con `autorizarSuperadmin`, nunca se confía en
// el rol de la cookie (ver app/api/campanas/zonas/route.ts). Sólo lectura:
// no exige el token anti-CSRF.
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
    return NextResponse.json({ ok: false, error: 'No tenés permiso para ver los correos enviados.' }, { status: 403 });
  }

  const id = (typeof crudo === 'object' && crudo !== null ? (crudo as Record<string, unknown>).id : undefined) as unknown;
  if (!esUuid(id)) {
    return NextResponse.json({ ok: false, error: 'El correo pedido no es válido.' }, { status: 400 });
  }

  try {
    const correo = await leerCorreoEnviado(db, id);
    if (!correo) return NextResponse.json({ ok: false, error: 'No se encontró ese correo.' }, { status: 404 });
    return NextResponse.json({ ok: true, correo });
  } catch (err) {
    console.error('[campanas] No se pudo leer el correo enviado.', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false, error: 'No se pudo consultar el correo.' }, { status: 500 });
  }
}
