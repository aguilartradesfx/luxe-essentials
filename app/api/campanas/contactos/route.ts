import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { ZONAS_COMERCIALES, contactosPorZona, conCorreo } from '@/lib/campanas/contactos';

export const runtime = 'nodejs';

const Entrada = z.object({ zona: z.enum(ZONAS_COMERCIALES) });

// Bandeja de campañas (parte 2): el contenido de UNA pestaña de zona.
// `contactosPorZona` ya trae la zona ENTERA en una sola llamada (pagina
// internamente contra GHL hasta agotarla, no expone un cursor hacia
// afuera) -- así que esta ruta manda la lista completa al navegador, y el
// paginado de 20/50/100 que pide el diseño se hace del lado del cliente,
// sin otro viaje de red por cambiar de página. Es también lo que hace
// posible, sin otra llamada, la casilla "seleccionar toda la zona": el
// navegador ya tiene, en esta misma respuesta, a quién le corresponde.
//
// Mismo criterio de autorización que el resto de app/api/campanas/* -- ver
// el comentario grande en app/api/campanas/zonas/route.ts.
export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  const auth = await autenticarPeticion(request, crudo, { requiereCsrf: false });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = supabaseAdmin();
  const autorizacion = await autorizarSuperadmin(auth.id, db);
  if (!autorizacion.ok) {
    return NextResponse.json({ ok: false, error: 'No tenés permiso para ver campañas.' }, { status: 403 });
  }

  const parseado = Entrada.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Zona inválida.' },
      { status: 400 },
    );
  }

  const deps = {
    apiKey: process.env.LUXE_GHL_API_KEY ?? '',
    locationId: process.env.LUXE_GHL_LOCATION_ID ?? '',
  };
  if (!deps.apiKey || !deps.locationId) {
    console.error('[campanas] Faltan LUXE_GHL_API_KEY o LUXE_GHL_LOCATION_ID.');
    return NextResponse.json({ ok: false, error: 'No se pudo consultar el CRM.' }, { status: 500 });
  }

  const resultado = await contactosPorZona(parseado.data.zona, deps);
  if (!resultado.ok) {
    console.error('[campanas] No se pudo traer los contactos de la zona.', parseado.data.zona, resultado.error);
    return NextResponse.json({ ok: false, error: 'No se pudo consultar el CRM.' }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    contactos: resultado.contactos,
    total: resultado.contactos.length,
    conCorreo: conCorreo(resultado.contactos).length,
  });
}
