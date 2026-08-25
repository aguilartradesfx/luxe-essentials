import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

function claveValida(recibida: string | null): boolean {
  const esperada = process.env.LUXE_TALLER_CLAVE;
  if (!esperada || !recibida) return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  let cuerpo: {
    clave?: string;
    etiqueta?: string;
    canal?: string;
    turnos?: unknown[];
    datos?: Record<string, unknown>;
    notas?: string;
  };
  try {
    cuerpo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  if (!claveValida(cuerpo.clave ?? null)) {
    return NextResponse.json({ ok: false, error: 'Clave incorrecta.' }, { status: 401 });
  }

  try {
    const db = supabaseAdmin();
    const { data, error } = await db
      .from('taller_notas')
      .insert({
        etiqueta: cuerpo.etiqueta?.trim() || null,
        canal: cuerpo.canal ?? null,
        turnos: cuerpo.turnos ?? [],
        datos: cuerpo.datos ?? {},
        notas: cuerpo.notas ?? '',
      })
      .select('id')
      .single();

    // El motivo importa y se devuelve tal cual: hoy el proyecto de Supabase no
    // existe, así que quien pulse Guardar necesita saber que el fallo es de
    // infraestructura y no de lo que escribió.
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
    }

    return NextResponse.json({ ok: true, id: data?.id });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
