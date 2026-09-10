import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { establecerPausado } from '@/lib/campanas/programado';

export const runtime = 'nodejs';

const Entrada = z.object({ pausado: z.boolean() });

// El interruptor de apagado del envío programado (encargo, punto 6): "sin
// necesidad de desplegar". Una persona con superadmin lo prende o lo apaga
// desde Historial de campañas -- este POST es la única forma de tocarlo.
// `ejecutarEnvioProgramado` lo comprueba en CADA corrida del cron, antes
// de resolver a qué zona le toca; ver el comentario grande en
// lib/campanas/programado.ts.
//
// Ruta que escribe: exige el token anti-CSRF, mismo criterio que
// /api/campanas/crear, /enviar y /cancelar -- ver el comentario grande en
// app/api/campanas/zonas/route.ts para el porqué de fondo (toda la
// superficie de campañas, no sólo mandar, queda detrás de superadmin).
export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  const auth = await autenticarPeticion(request, crudo, { requiereCsrf: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = supabaseAdmin();
  const autorizacion = await autorizarSuperadmin(auth.id, db);
  if (!autorizacion.ok) {
    return NextResponse.json(
      { ok: false, error: 'No tenés permiso para pausar el envio programado.' },
      { status: 403 },
    );
  }

  const parseado = Entrada.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }

  try {
    await establecerPausado(db, parseado.data.pausado, auth.vendedor);
  } catch (err) {
    console.error('[campanas] No se pudo actualizar el interruptor del envio programado.', err);
    return NextResponse.json(
      { ok: false, error: 'No se pudo actualizar el interruptor del envio programado.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, pausado: parseado.data.pausado });
}
