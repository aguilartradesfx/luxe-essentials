import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { enlaceFirmado } from '@/lib/cotizador/almacen';

export const runtime = 'nodejs';

// Ronda de correcciones final (hallazgo importante): el diseño lista cinco
// acciones por fila en el listado (ver PDF, reenviar, duplicar, ir al
// contacto, ganada/perdida) — "ver el PDF" era la única que nunca se
// construyó. Sin esta ruta, la única forma de ver un PDF ya guardado era
// reenviárselo al cliente, así que cuando un hotel llama preguntando por su
// cotización el vendedor no tiene forma de abrirla. Ruta de solo lectura
// dedicada, mismo patrón que app/api/cotizacion/duplicar/route.ts: firma el
// enlace de un PDF que ya existe en Storage, no genera nada nuevo.
const pdfSchema = z.object({
  clave: z.string().optional(),
  // Mismo motivo que en /cerrar, /reenviar y /duplicar: un id sin forma de
  // UUID revienta en Postgres como 500 en vez de 400.
  id: z.uuid('El id de la cotización no es válido.'),
});

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // La credencial se revisa antes que el esquema: mismo motivo que en el
  // resto de app/api/cotizacion/*. Ruta de solo lectura (SELECT + firma de
  // un enlace ya existente): no exige el token anti-CSRF.
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: false });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const parseado = pdfSchema.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }
  const datos = parseado.data;

  const db = supabaseAdmin();

  const { data: fila, error } = await db
    .from('cotizaciones')
    .select('pdf_ruta')
    .eq('id', datos.id)
    .maybeSingle();

  if (error) {
    console.error('[cotizador] No se pudo consultar la cotización para ver el PDF.', error.message);
    return NextResponse.json({ ok: false, error: 'No se pudo consultar.' }, { status: 500 });
  }

  if (!fila) {
    return NextResponse.json({ ok: false, error: 'Cotización no encontrada.' }, { status: 404 });
  }

  const pdfRuta = (fila as { pdf_ruta?: string | null }).pdf_ruta ?? null;
  if (!pdfRuta) {
    return NextResponse.json(
      { ok: false, error: 'Esta cotización no tiene un PDF guardado.' },
      { status: 400 },
    );
  }

  const firmado = await enlaceFirmado(pdfRuta, db);
  if (!firmado.ok) {
    console.error('[cotizador] No se pudo firmar el enlace del PDF para verlo.', firmado.error);
    return NextResponse.json({ ok: false, error: 'No se pudo firmar el enlace del PDF.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, url: firmado.url });
}
