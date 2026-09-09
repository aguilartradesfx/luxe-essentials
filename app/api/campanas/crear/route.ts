import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { ZONAS_COMERCIALES, contactosPorZona, conCorreo } from '@/lib/campanas/contactos';
import { TODAS_LAS_PLANTILLAS, PLANTILLA_PERSONALIZADA, crearCampana } from '@/lib/campanas/envio';
import { plantillaCargada } from '@/lib/campanas/plantillas';
import { contarParrafosEditables, aplicarParrafosEditados } from '@/lib/campanas/edicion';
import { filtrarPermitidosParaCampana } from '@/lib/campanas/exclusiones';
import {
  sanitizarHtmlPersonalizado,
  validarMarcadorBaja,
  previsualizacionValida,
} from '@/lib/campanas/plantilla-personalizada';

export const runtime = 'nodejs';

// Menor m4 (revisión final): ésta es, junto con `/zonas`, la ruta pesada de
// `app/api/campanas/*` que quedaba sin declarar `maxDuration` -- mismo
// criterio que `app/api/cotizacion/route.ts` y que `enviar`. Pagina una zona
// entera contra GoHighLevel, lee la tabla de bajas e inserta hasta 3.340
// filas de destinatarios. Cortada a mitad del upsert queda una campaña con
// la lista INCOMPLETA y el navegador sin `campanaId`: se recupera desde
// Historial, pero mandaría a menos gente de la que quien la creó cree, sin
// que nada en pantalla lo diga.
export const maxDuration = 60;

// `seleccion` es el candado central de esta ruta -- ver el comentario
// grande, más abajo, sobre por qué NUNCA se confía en la lista de
// destinatarios que manda el navegador.
const Entrada = z.object({
  zona: z.enum(ZONAS_COMERCIALES),
  seleccion: z.enum(['pagina', 'zona']),
  // Sólo tiene sentido (y sólo se usa) cuando `seleccion` es 'pagina': los
  // `contactId` que la persona marcó en la página que tenía a la vista.
  // Cuando `seleccion` es 'zona', este campo se IGNORA por completo -- ver
  // más abajo -- así que ni falta que haga mandarlo, pero tampoco es un
  // error mandarlo de más.
  contactIds: z.array(z.string().min(1)).optional(),
  plantilla: z.enum(TODAS_LAS_PLANTILLAS),
  // Sólo para las cuatro plantillas FIJAS.
  parrafos: z.array(z.string()).optional(),
  // Sólo para 'personalizada' -- ver el bloque `if (plantilla === PLANTILLA_PERSONALIZADA)`
  // más abajo. `firmaPrevisualizacion` es la que exige haber pasado por
  // POST /api/campanas/previsualizar con este mismo asunto+html antes de
  // poder crear la campaña -- ver el comentario grande de
  // `firmarPrevisualizacion` en lib/campanas/plantilla-personalizada.ts.
  asunto: z.string().optional(),
  previewText: z.string().optional(),
  html: z.string().optional(),
  firmaPrevisualizacion: z.string().optional(),
});

// Bandeja de campañas (parte 2): crea la campaña. La ruta que sí escribe --
// exige el token anti-CSRF, a diferencia de zonas/contactos/plantillas/previsualizar.
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

  const auth = await autenticarPeticion(request, crudo, { requiereCsrf: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = supabaseAdmin();
  const autorizacion = await autorizarSuperadmin(auth.id, db);
  if (!autorizacion.ok) {
    return NextResponse.json({ ok: false, error: 'No tenés permiso para crear campañas.' }, { status: 403 });
  }

  const parseado = Entrada.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }
  const { zona, seleccion, contactIds, plantilla } = parseado.data;

  if (seleccion === 'pagina' && (!contactIds || contactIds.length === 0)) {
    return NextResponse.json(
      { ok: false, error: 'No hay ningún destinatario seleccionado en esta página.' },
      { status: 400 },
    );
  }

  // El contenido final del correo -- de una de las cuatro plantillas fijas,
  // o de 'personalizada' (encargo del dueño, punto 3). Se resuelve ACÁ,
  // antes de tocar GHL para nada: mismo criterio que ya tenía esta ruta con
  // el conteo de párrafos ("fallar rápido, antes de gastar una consulta al
  // CRM"), sólo que ahora la validación de 'personalizada' es la que manda
  // más -- el marcador de baja obligatorio y la firma de "ya se
  // previsualizó" (ver lib/campanas/plantilla-personalizada.ts).
  let asuntoFinal: string;
  let previewTextFinal: string | undefined;
  let htmlFinal: string;
  let advertenciasHtml: string[] = [];

  if (plantilla === PLANTILLA_PERSONALIZADA) {
    const asunto = (parseado.data.asunto ?? '').trim();
    const htmlCrudo = parseado.data.html ?? '';
    if (!asunto) return NextResponse.json({ ok: false, error: 'Falta el asunto.' }, { status: 400 });
    if (!htmlCrudo.trim()) return NextResponse.json({ ok: false, error: 'Falta el HTML del correo.' }, { status: 400 });

    // Nunca se confía en un html "ya saneado" que mandara el cliente -- se
    // vuelve a sanear ACÁ, del lado del servidor, sobre el crudo. Es lo que
    // hace que `previsualizacionValida` (más abajo) sea una comprobación de
    // verdad y no un campo que alcanzaría con copiar de la respuesta de
    // /previsualizar.
    const { html: htmlSaneado, advertencias } = sanitizarHtmlPersonalizado(htmlCrudo);
    advertenciasHtml = advertencias;

    const validacionBaja = validarMarcadorBaja(htmlSaneado);
    if (!validacionBaja.ok) {
      return NextResponse.json({ ok: false, error: validacionBaja.error }, { status: 400 });
    }

    const firma = parseado.data.firmaPrevisualizacion ?? '';
    if (!previsualizacionValida(asunto, htmlSaneado, firma)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Hay que previsualizar el HTML pegado (con este mismo asunto y contenido) antes de poder enviar la campaña. ' +
            'Si lo editaste después de previsualizarlo, previsualizalo de nuevo.',
        },
        { status: 400 },
      );
    }

    asuntoFinal = asunto;
    previewTextFinal = (parseado.data.previewText ?? '').trim() || undefined;
    htmlFinal = htmlSaneado;
  } else {
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
    asuntoFinal = cargada.asunto;
    previewTextFinal = cargada.previewText;
    htmlFinal = aplicarParrafosEditados(cargada.html, parrafos);
  }

  const deps = {
    apiKey: process.env.LUXE_GHL_API_KEY ?? '',
    locationId: process.env.LUXE_GHL_LOCATION_ID ?? '',
  };
  if (!deps.apiKey || !deps.locationId) {
    console.error('[campanas] Faltan LUXE_GHL_API_KEY o LUXE_GHL_LOCATION_ID.');
    return NextResponse.json({ ok: false, error: 'No se pudo consultar el CRM.' }, { status: 500 });
  }

  const resultadoZona = await contactosPorZona(zona, deps);
  if (!resultadoZona.ok) {
    console.error('[campanas] No se pudo traer los contactos de la zona al crear la campaña.', zona, resultadoZona.error);
    return NextResponse.json({ ok: false, error: 'No se pudo consultar el CRM.' }, { status: 502 });
  }

  // El candado: la lista de destinatarios se decide ACÁ, contra lo que GHL
  // dice AHORA MISMO -- nunca contra lo que el navegador afirma que eligió.
  // El navegador sólo manda DOS cosas posibles: "toda la zona" (una
  // palabra, `seleccion === 'zona'`) o "estos contactId de la página que
  // tenía a la vista" (`seleccion === 'pagina'` + `contactIds`). En ningún
  // caso el cuerpo de la petición trae un correo: si lo trajera y esta ruta
  // lo usara tal cual, cualquiera que supiera armar el POST -- o un bug del
  // lado del cliente -- podría colar un destinatario que no es un contacto
  // real de esta zona. Con este diseño eso no compila ni en el sentido
  // figurado: no hay ningún camino por el que un correo inventado llegue a
  // `crearCampana`.
  //
  // Es también la diferencia que el diseño pide que sea IMPOSIBLE de
  // confundir entre "toda la página" y "toda la zona": son dos ramas
  // distintas de este `if`, no un mismo cálculo con un parámetro que se
  // pueda pisar por descuido -- `seleccion === 'zona'` toma la lista
  // COMPLETA sin mirar `contactIds` para nada, y `seleccion === 'pagina'`
  // nunca ve más que los ids que el navegador marcó.
  const todosConCorreo = conCorreo(resultadoZona.contactos);
  const destinatarios =
    seleccion === 'zona'
      ? todosConCorreo
      : todosConCorreo.filter((d) => contactIds!.includes(d.contactId));

  if (destinatarios.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'Ninguno de los contactos seleccionados tiene correo en el CRM.' },
      { status: 400 },
    );
  }

  let permitidos;
  try {
    permitidos = await filtrarPermitidosParaCampana(destinatarios, db);
  } catch (err) {
    console.error('[campanas] No se pudo leer la lista de bajas al crear la campaña.', err);
    return NextResponse.json({ ok: false, error: 'No se pudo verificar la lista de bajas.' }, { status: 500 });
  }

  if (permitidos.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'Todos los contactos seleccionados están dados de baja de estos correos.' },
      { status: 400 },
    );
  }

  const resultado = await crearCampana(
    {
      zona,
      plantilla,
      asunto: asuntoFinal,
      previewText: previewTextFinal,
      html: htmlFinal,
      creadoPor: auth.vendedor,
    },
    permitidos,
    db,
  );

  if (!resultado.ok) {
    console.error('[campanas] No se pudo crear la campaña.', resultado.error);
    return NextResponse.json({ ok: false, error: resultado.error }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    campanaId: resultado.campanaId,
    destinatarios: resultado.destinatarios,
    // Cuántos de la selección se descartaron porque ya estaban de baja --
    // visible para que quien creó la campaña sepa que el número final no
    // es el mismo que había en pantalla, y por qué.
    excluidosPorBaja: destinatarios.length - permitidos.length,
    // Sólo para 'personalizada' -- qué se le quitó al html pegado antes de
    // guardarlo (ver lib/campanas/plantilla-personalizada.ts). Vacío para
    // las cuatro plantillas fijas.
    advertenciasHtml,
  });
}
