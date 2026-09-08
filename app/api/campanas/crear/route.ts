import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { ZONAS_COMERCIALES, contactosPorZona, conCorreo } from '@/lib/campanas/contactos';
import { PLANTILLAS, crearCampana } from '@/lib/campanas/envio';
import { plantillaCargada } from '@/lib/campanas/plantillas';
import { contarParrafosEditables, aplicarParrafosEditados } from '@/lib/campanas/edicion';
import { filtrarPermitidosParaCampana } from '@/lib/campanas/exclusiones';

export const runtime = 'nodejs';

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
  plantilla: z.enum(PLANTILLAS),
  parrafos: z.array(z.string()),
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

  const auth = autenticarPeticion(request, crudo, { requiereCsrf: true });
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
  const { zona, seleccion, contactIds, plantilla, parrafos } = parseado.data;

  if (seleccion === 'pagina' && (!contactIds || contactIds.length === 0)) {
    return NextResponse.json(
      { ok: false, error: 'No hay ningún destinatario seleccionado en esta página.' },
      { status: 400 },
    );
  }

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

  const html = aplicarParrafosEditados(cargada.html, parrafos);

  const resultado = await crearCampana(
    {
      plantilla,
      asunto: cargada.asunto,
      previewText: cargada.previewText,
      html,
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
  });
}
