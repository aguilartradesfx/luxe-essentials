import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// Es POST —no GET— porque la clave puede viajar en el cuerpo: una clave en
// la barra de direcciones queda en el historial del navegador y en los
// registros del servidor.
export async function POST(request: Request) {
  let cuerpo: unknown;
  try {
    cuerpo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // Ruta de solo lectura (SELECT): la sesión por cookie basta, sin exigir el
  // token anti-CSRF que sí piden las que escriben.
  const auth = autenticarPeticion(request, cuerpo, { requiereCsrf: false });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const { data, error } = await supabaseAdmin()
    .from('cotizaciones')
    .select('id, created_at, contact_id, cliente')
    .eq('estado', 'borrador')
    // El filtro por origen no es opcional. La Tarea 6 inserta las cotizaciones
    // humanas como 'borrador' antes de mandarlas a GoHighLevel, así que una
    // cotización en vuelo aparecería en la cola del agente sin este filtro.
    .eq('origen', 'agente')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[cotizador] No se pudieron leer los borradores.', error.message);
    return NextResponse.json({ ok: false, error: 'No se pudo consultar.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, borradores: data ?? [] });
}
