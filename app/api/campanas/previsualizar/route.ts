import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { PLANTILLAS } from '@/lib/campanas/envio';
import { plantillaCargada } from '@/lib/campanas/plantillas';
import { contarParrafosEditables, aplicarParrafosEditados } from '@/lib/campanas/edicion';
import { renderizarPlantilla } from '@/lib/campanas/marcadores';
import { enlacePaginaBaja } from '@/lib/campanas/baja';

export const runtime = 'nodejs';

const Entrada = z.object({
  plantilla: z.enum(PLANTILLAS),
  // Uno por párrafo editable de la plantilla elegida -- el conteo exacto se
  // valida más abajo, contra la propia plantilla, porque depende de CUÁL
  // plantilla se eligió (no es el mismo número para las cuatro).
  parrafos: z.array(z.string()),
  destinatario: z.object({
    nombreCrm: z.string().trim().min(1, 'Falta el nombre del destinatario.'),
    correo: z.string().trim().min(1, 'Falta el correo del destinatario.'),
  }),
});

// Bandeja de campañas (parte 2): "ver antes de enviar", con un destinatario
// REAL de la selección -- su nombre, su empresa, su enlace de baja --
// exactamente como pide el diseño
// (docs/superpowers/specs/2026-09-08-campanas-design.md, "Se ve antes de
// enviar"). No escribe nada: ni en `campanas` ni en `campanas_envios` --
// arma el HTML final en memoria y lo devuelve, nada más.
//
// Mismo criterio de autorización que el resto de app/api/campanas/* -- ver
// el comentario grande en app/api/campanas/zonas/route.ts. Ruta de sólo
// lectura: no exige el token anti-CSRF.
export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  const auth = autenticarPeticion(request, crudo, { requiereCsrf: false });
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
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }
  const { plantilla, parrafos, destinatario } = parseado.data;

  const cargada = plantillaCargada(plantilla);
  const esperados = contarParrafosEditables(cargada.html);
  if (parrafos.length !== esperados) {
    return NextResponse.json(
      {
        ok: false,
        error: `Esta plantilla tiene ${esperados} párrafo(s) editable(s), pero llegaron ${parrafos.length}.`,
      },
      { status: 400 },
    );
  }

  let enlaceBaja: string;
  try {
    enlaceBaja = enlacePaginaBaja(destinatario.correo);
  } catch (err) {
    // `enlacePaginaBaja` lanza si falta `LUXE_BAJA_SECRETO` -- un problema
    // de configuración del servidor, nunca del pedido de quien previsualiza.
    console.error('[campanas] No se pudo armar el enlace de baja para la vista previa.', err);
    return NextResponse.json({ ok: false, error: 'No se pudo armar la vista previa.' }, { status: 500 });
  }

  const htmlConParrafos = aplicarParrafosEditados(cargada.html, parrafos);
  const html = renderizarPlantilla(htmlConParrafos, {
    nombreCrm: destinatario.nombreCrm,
    unsubscribeUrl: enlaceBaja,
  });

  return NextResponse.json({ ok: true, asunto: cargada.asunto, previewText: cargada.previewText, html });
}
