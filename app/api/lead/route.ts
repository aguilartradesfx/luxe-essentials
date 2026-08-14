import { NextResponse } from 'next/server';
import { leadSchema } from '@/lib/validation';
import { supabaseAdmin } from '@/lib/supabase/server';
import { upsertContact } from '@/lib/ghl';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    let crudo: unknown;
    try {
      crudo = await request.json();
    } catch {
      // Mismo shape que un 400 de validación: el formulario siempre lee
      // `errores`, nunca `error`, así que esta es la única excepción que no
      // debe existir.
      return NextResponse.json({ ok: false, errores: {} }, { status: 400 });
    }

    const parsed = leadSchema.safeParse(crudo);
    if (!parsed.success) {
      // `.issues` es estable entre versiones de Zod; `.flatten()` está en desuso en Zod 4.
      const errores = Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message]),
      );
      return NextResponse.json({ ok: false, errores }, { status: 400 });
    }

    const lead = parsed.data;
    const db = supabaseAdmin();

    // Primero la base: si GHL falla después, el lead no se pierde.
    const { data: fila, error: errorInsert } = await db
      .from('leads')
      .insert({
        nombre: lead.nombre,
        empresa: lead.empresa || null,
        email: lead.email,
        telefono: lead.telefono || null,
        linea: lead.linea,
        cantidad: lead.cantidad || null,
        mensaje: lead.mensaje || null,
        utm: lead.utm ?? null,
      })
      .select()
      .single();

    if (errorInsert || !fila) {
      return NextResponse.json(
        { ok: false, error: 'No pudimos guardar tu solicitud.' },
        { status: 500 },
      );
    }

    const resultado = await upsertContact(lead, {
      apiKey: process.env.LUXE_GHL_API_KEY ?? '',
      locationId: process.env.LUXE_GHL_LOCATION_ID ?? '',
    });

    const { error: errorUpdate } = await db
      .from('leads')
      .update(
        resultado.ok
          ? {
              ghl_contact_id: resultado.contactId,
              ghl_synced_at: new Date().toISOString(),
              // Si la nota falló, el contacto sí existe: se deja constancia
              // pero NO se devuelve la fila a la cola de reintento, que
              // filtra justamente por `ghl_contact_id is null`.
              ghl_error: resultado.notaError ? `nota: ${resultado.notaError}` : null,
            }
          : { ghl_error: resultado.error },
      )
      .eq('id', fila.id);

    if (errorUpdate) {
      if (resultado.ok) {
        // El contacto SÍ quedó creado en GHL, pero Supabase no pudo
        // registrar su id: la fila se queda con `ghl_contact_id is null` y
        // la cola de reintento la recoge, creando un contacto duplicado en
        // el CRM del cliente. Un humano tiene que reconciliar esto a mano.
        console.error(
          '[lead] GHL creó el contacto pero Supabase no pudo registrarlo — reconciliar a mano.',
          'fila:',
          fila.id,
          'ghl_contact_id:',
          resultado.contactId,
          errorUpdate,
        );
      } else {
        console.error(
          '[lead] No se pudo registrar en Supabase el error de GHL.',
          'fila:',
          fila.id,
          errorUpdate,
        );
      }
    }

    if (!resultado.ok) {
      console.error('[lead] GHL falló, lead guardado en Supabase:', fila.id, resultado.error);
    }

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    // Red de seguridad: cualquier throw inesperado (p.ej. supabaseAdmin()
    // sin credenciales) debe seguir cumpliendo el contrato de respuesta
    // `500 { ok: false, error }` en vez de la página de error genérica de
    // Next.js. El detalle va al log del servidor, nunca a la respuesta.
    console.error('[lead] Error inesperado en el route handler:', err);
    return NextResponse.json(
      { ok: false, error: 'No pudimos procesar tu solicitud.' },
      { status: 500 },
    );
  }
}
