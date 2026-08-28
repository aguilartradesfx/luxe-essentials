import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const cerrarSchema = z.object({
  clave: z.string().optional(),
  id: z.string().min(1, 'Falta el id de la cotización.'),
  // Único par de estados que un vendedor puede poner a mano desde el panel:
  // cualquier otro valor —incluidos los que el propio sistema asigna solo,
  // como 'enviada' o 'error'— se rechaza acá.
  estado: z.enum(['ganada', 'perdida'], { message: 'El estado debe ser "ganada" o "perdida".' }),
  motivo: z.string().trim().max(500, 'Resume un poco el motivo.').optional(),
});

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // La credencial se revisa antes que el esquema: mismo motivo que en el
  // resto de app/api/cotizacion/*. Esta ruta escribe (cierra la cotización):
  // `requiereCsrf: true` exige el token anti-CSRF cuando se entra por
  // cookie (ver lib/autenticacion-cotizador.ts) — con `SameSite=None` esa
  // cookie viaja sola en peticiones que origina cualquier otro sitio que el
  // vendedor visite, y el token es la única defensa contra eso.
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const parseado = cerrarSchema.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }
  const datos = parseado.data;

  const cambios: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    estado: datos.estado,
    cerrada_at: new Date().toISOString(),
  };
  // Solo 'perdida' guarda el motivo: cerrar 'ganada' no lo pide, y no vale
  // la pena pisarlo con null si el vendedor lo escribió y cambió de botón
  // antes de mandar.
  if (datos.estado === 'perdida') {
    cambios.motivo_cierre = datos.motivo ?? null;
  }

  const { error } = await supabaseAdmin().from('cotizaciones').update(cambios).eq('id', datos.id);

  if (error) {
    console.error('[cotizador] No se pudo cerrar la cotización.', error.message);
    return NextResponse.json({ ok: false, error: 'No se pudo actualizar.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
