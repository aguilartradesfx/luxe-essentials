import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin, invitarPersona } from '@/lib/cotizador/equipo';
import { ROLES } from '@/lib/cotizador/usuarios';

export const runtime = 'nodejs';

const SIN_PERMISO = 'No tenés permiso para administrar el equipo.';

const Entrada = z.object({
  correo: z.string().trim().pipe(z.email('El correo no es válido.')),
  nombre: z.string().trim().min(1, 'Falta el nombre.').max(120, 'Escribe un nombre más corto.'),
  rol: z.enum(ROLES, { message: 'El rol debe ser "vendedor" o "superadmin".' }),
});

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // La credencial (y la autorización, más abajo) se revisan antes que el
  // esquema: mismo motivo que en el resto de app/api/*, extendido a "no
  // revelar la forma esperada del cuerpo a quien no puede usarlo". Esta
  // ruta escribe (crea una fila): exige el token anti-CSRF.
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

  const resultado = await invitarPersona(
    db,
    { apiKey: process.env.RESEND_API_KEY ?? '', remitente: process.env.LUXE_CORREO_REMITENTE ?? '' },
    parseado.data,
  );

  if (!resultado.ok) {
    if (resultado.motivo === 'duplicado') {
      return NextResponse.json({ ok: false, error: 'Ese correo ya está en el equipo.' }, { status: 409 });
    }
    console.error('[cotizador] No se pudo invitar a la persona.', resultado.error);
    return NextResponse.json({ ok: false, error: 'No se pudo invitar a esa persona.' }, { status: 500 });
  }

  // La fila ya quedó creada aunque `correoEnviado` sea `false`: la pantalla
  // tiene que avisarlo, o quien invitó cree que invitó a alguien que nunca
  // se enteró (ver lib/cotizador/equipo.ts).
  return NextResponse.json({ ok: true, correoEnviado: resultado.correoEnviado });
}
