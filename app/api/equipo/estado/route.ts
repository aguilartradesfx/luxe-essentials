import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin, cambiarEstado } from '@/lib/cotizador/equipo';
import { ROLES } from '@/lib/cotizador/usuarios';

export const runtime = 'nodejs';

const SIN_PERMISO = 'No tenés permiso para administrar el equipo.';

const Entrada = z
  .object({
    id: z.uuid('El id no es válido.'),
    activo: z.boolean().optional(),
    rol: z.enum(ROLES, { message: 'El rol debe ser "vendedor" o "superadmin".' }).optional(),
  })
  // Sin `activo` ni `rol` no hay nada que cambiar: un cuerpo así no debe
  // llegar a `cambiarEstado` a hacer un `update` vacío.
  .refine((datos) => datos.activo !== undefined || datos.rol !== undefined, {
    message: 'Indicá qué cambiar: activo o rol.',
  });

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // Esta ruta escribe (desactiva o degrada a alguien): exige el token
  // anti-CSRF, igual que /invitar y /reenviar.
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = supabaseAdmin();

  const autorizacion = await autorizarSuperadmin(auth.vendedor, db);
  if (!autorizacion.ok) {
    return NextResponse.json({ ok: false, error: SIN_PERMISO }, { status: 403 });
  }

  const parseado = Entrada.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }

  const { id, ...cambios } = parseado.data;

  const resultado = await cambiarEstado(db, id, cambios);

  if (!resultado.ok) {
    if (resultado.motivo === 'no_encontrado') {
      return NextResponse.json({ ok: false, error: 'Esa persona no está en el equipo.' }, { status: 404 });
    }
    if (resultado.motivo === 'ultimo_superadmin') {
      return NextResponse.json(
        { ok: false, error: 'No se puede completar: dejaría al equipo sin su último superadmin activo.' },
        { status: 409 },
      );
    }
    console.error('[cotizador] No se pudo actualizar el estado del equipo.', resultado.error);
    return NextResponse.json({ ok: false, error: 'No se pudo guardar el cambio.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
