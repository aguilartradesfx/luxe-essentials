import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { TODAS_LAS_PLANTILLAS, PLANTILLA_PERSONALIZADA } from '@/lib/campanas/envio';
import { plantillaCargada } from '@/lib/campanas/plantillas';
import { contarParrafosEditables, aplicarParrafosEditados } from '@/lib/campanas/edicion';
import { renderizarPlantilla } from '@/lib/campanas/marcadores';
import { enlacePaginaBaja } from '@/lib/campanas/baja';
import { sanitizarHtmlPersonalizado, validarMarcadorBaja, firmarPrevisualizacion } from '@/lib/campanas/plantilla-personalizada';

export const runtime = 'nodejs';

const Entrada = z.object({
  plantilla: z.enum(TODAS_LAS_PLANTILLAS),
  // Sólo para las cuatro plantillas FIJAS -- uno por párrafo editable, el
  // conteo exacto se valida más abajo, contra la propia plantilla. Para
  // 'personalizada' se ignora por completo (ver `asunto`/`html`, abajo).
  parrafos: z.array(z.string()).optional(),
  // Sólo para 'personalizada' -- ver el bloque `if (plantilla === PLANTILLA_PERSONALIZADA)`
  // más abajo. Para las cuatro fijas se ignoran: el asunto y el html salen
  // de plantillaCargada(), nunca de lo que mande el cliente.
  asunto: z.string().optional(),
  previewText: z.string().optional(),
  html: z.string().optional(),
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
// Con 'personalizada' (encargo del dueño, punto 3) esta ruta pesa más que
// nunca: es la única defensa que queda contra un HTML pegado a mano roto o
// peligroso, así que acá es donde el html crudo se sanea
// (`sanitizarHtmlPersonalizado`), se exige el marcador de baja
// (`validarMarcadorBaja`) y se firma el resultado (`firmarPrevisualizacion`)
// para que POST /api/campanas/crear pueda comprobar que lo que está por
// guardar es EXACTAMENTE lo que se vio acá -- ver el comentario grande de
// esa función en lib/campanas/plantilla-personalizada.ts.
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
  const { plantilla, destinatario } = parseado.data;

  let enlaceBaja: string;
  try {
    enlaceBaja = enlacePaginaBaja(destinatario.correo);
  } catch (err) {
    // `enlacePaginaBaja` lanza si falta `LUXE_BAJA_SECRETO` -- un problema
    // de configuración del servidor, nunca del pedido de quien previsualiza.
    console.error('[campanas] No se pudo armar el enlace de baja para la vista previa.', err);
    return NextResponse.json({ ok: false, error: 'No se pudo armar la vista previa.' }, { status: 500 });
  }

  if (plantilla === PLANTILLA_PERSONALIZADA) {
    const asunto = (parseado.data.asunto ?? '').trim();
    const htmlCrudo = parseado.data.html ?? '';
    if (!asunto) return NextResponse.json({ ok: false, error: 'Falta el asunto.' }, { status: 400 });
    if (!htmlCrudo.trim()) return NextResponse.json({ ok: false, error: 'Falta el HTML del correo.' }, { status: 400 });

    const { html: htmlSaneado, advertencias } = sanitizarHtmlPersonalizado(htmlCrudo);
    const validacionBaja = validarMarcadorBaja(htmlSaneado);
    if (!validacionBaja.ok) {
      return NextResponse.json({ ok: false, error: validacionBaja.error }, { status: 400 });
    }

    const html = renderizarPlantilla(htmlSaneado, {
      nombreCrm: destinatario.nombreCrm,
      unsubscribeUrl: enlaceBaja,
    });

    return NextResponse.json({
      ok: true,
      asunto,
      previewText: (parseado.data.previewText ?? '').trim(),
      html,
      advertencias,
      // Lo que POST /api/campanas/crear exige para poder guardar y mandar
      // esta campaña -- ver el comentario grande de `firmarPrevisualizacion`.
      firmaPrevisualizacion: firmarPrevisualizacion(asunto, htmlSaneado),
    });
  }

  const parrafos = parseado.data.parrafos ?? [];
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

  const htmlConParrafos = aplicarParrafosEditados(cargada.html, parrafos);
  const html = renderizarPlantilla(htmlConParrafos, {
    nombreCrm: destinatario.nombreCrm,
    unsubscribeUrl: enlaceBaja,
  });

  return NextResponse.json({ ok: true, asunto: cargada.asunto, previewText: cargada.previewText, html });
}
