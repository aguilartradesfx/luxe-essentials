import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// Mismo criterio que el resto de app/api/cotizacion/*: comparación en tiempo
// constante, y es POST —no GET— porque la clave viaja en el cuerpo. Una
// clave en la barra de direcciones queda en el historial del navegador y en
// los registros del servidor.
function claveValida(recibida: unknown): boolean {
  const esperada = process.env.LUXE_TALLER_CLAVE;
  if (!esperada || typeof recibida !== 'string') return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  let cuerpo: { clave?: unknown };
  try {
    cuerpo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  if (!claveValida(cuerpo.clave)) {
    return NextResponse.json({ ok: false, error: 'Clave incorrecta.' }, { status: 401 });
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
