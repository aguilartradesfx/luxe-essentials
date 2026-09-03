import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { listarPendientes, SIN_PERMISO_APROBAR } from '@/lib/cotizador/aprobacion';

export const runtime = 'nodejs';

// Fase 5 (descuento con aprobación): la cola de cotizaciones en
// 'esperando_aprobacion', sólo visible para un superadmin. Distinta de
// /listado -- esa trae TODAS las cotizaciones para la pantalla principal,
// sin `lineas` (deliberadamente liviana); ésta trae sólo las pendientes,
// con `lineas` incluidas, porque la pantalla de aprobación necesita poder
// mostrar el efecto de cambiar el porcentaje antes de aprobar.
export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // Ruta de solo lectura (SELECT): no exige el token anti-CSRF, igual que
  // /listado y /api/equipo/listar.
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: false });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = supabaseAdmin();

  // `auth.rol` sale de la cookie y no autoriza nada (lib/autenticacion-cotizador.ts).
  // `autorizarSuperadmin` relee la fila de quien pide la lista antes de
  // dejarlo ver quién pidió qué descuento, para cuáles clientes.
  const autorizacion = await autorizarSuperadmin(auth.id, db);
  if (!autorizacion.ok) {
    return NextResponse.json({ ok: false, error: SIN_PERMISO_APROBAR }, { status: 403 });
  }

  const resultado = await listarPendientes(db);
  if (!resultado.ok) {
    console.error('[cotizador] No se pudo consultar el listado de aprobaciones pendientes.', resultado.error);
    return NextResponse.json({ ok: false, error: 'No se pudo consultar.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, cotizaciones: resultado.cotizaciones });
}
