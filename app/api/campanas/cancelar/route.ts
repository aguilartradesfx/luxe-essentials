import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { cancelarCampana } from '@/lib/campanas/envio';

export const runtime = 'nodejs';

const Entrada = z.object({ campanaId: z.string().min(1, 'Falta el id de la campaña.') });

// Punto 1 del encargo: poder cancelar una campaña ya creada. Detiene lo que
// falta -- una tanda en curso reclama pendientes contra
// `campanas_reclamar_pendientes` (migración 0020), que deja de entregar
// nada de esta campaña apenas la cancelación queda escrita, sin importar
// quién la esté mandando ni desde dónde. Lo ya enviado NO se toca -- ver el
// comentario grande de `cancelarCampana` (lib/campanas/envio.ts).
//
// Mismo criterio de autorización y de CSRF que /api/campanas/crear y
// /api/campanas/enviar -- las otras dos rutas que escriben de verdad: exige
// el token anti-CSRF, y exige superadmin releído de la base
// (`autorizarSuperadmin`), nunca del rol de la cookie. Ver el comentario
// grande en app/api/campanas/zonas/route.ts para el porqué de fondo.
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
    return NextResponse.json({ ok: false, error: 'No tenés permiso para cancelar campañas.' }, { status: 403 });
  }

  const parseado = Entrada.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }

  const resultado = await cancelarCampana(parseado.data.campanaId, auth.vendedor, db);
  if (!resultado.ok) {
    console.error('[campanas] No se pudo cancelar una campaña.', parseado.data.campanaId, resultado.error);
    return NextResponse.json(
      { ok: false, error: resultado.error },
      { status: resultado.codigo === 'no_existe' ? 404 : 500 },
    );
  }

  return NextResponse.json({ ok: true, yaEstabaCancelada: resultado.yaEstabaCancelada });
}
