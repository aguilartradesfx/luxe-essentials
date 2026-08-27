import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { cotizacionSchema } from '@/lib/validation';
import { calcular } from '@/lib/cotizador/calcular';
import { CATALOGO } from '@/lib/cotizador/catalogo';
import { crearEstimate } from '@/lib/cotizador/ghl';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// Mismo criterio que app/api/q7m4/route.ts: comparación en tiempo constante.
function claveValida(recibida: string | null): boolean {
  const esperada = process.env.LUXE_TALLER_CLAVE;
  if (!esperada || !recibida) return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // La clave se revisa antes que el esquema: si alguien sin credenciales manda
  // un cuerpo mal formado, no debe recibir mensajes de validación que revelen
  // la forma esperada del cuerpo. Mismo orden que app/api/q7m4/route.ts.
  const claveRecibida =
    typeof crudo === 'object' && crudo !== null && 'clave' in crudo
      ? (crudo as { clave?: unknown }).clave
      : undefined;
  if (!claveValida(typeof claveRecibida === 'string' ? claveRecibida : null)) {
    return NextResponse.json({ ok: false, error: 'Clave incorrecta.' }, { status: 401 });
  }

  const parseado = cotizacionSchema.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }
  const datos = parseado.data;

  // `calcular` lanza si un SKU no existe o la cantidad es absurda. Eso es un
  // error del cliente, no del servidor: se traduce a 400 en vez de dejar que
  // reviente en 500.
  let cotizacion;
  try {
    cotizacion = calcular(datos.lineas, CATALOGO, {
      tasaIva: datos.tasaIva,
      bordadoEspecial: datos.bordadoEspecial,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'No se pudo calcular.' },
      { status: 400 },
    );
  }

  // Primero la base, después GoHighLevel (Tarea 7). Si el CRM falla, la
  // cotización sigue existiendo y es recuperable; al revés, el cliente tendría
  // una cotización que Luxe no registró.
  const { data, error } = await supabaseAdmin()
    .from('cotizaciones')
    .insert({
      origen: 'humano',
      estado: 'borrador',
      cliente: datos.cliente,
      lineas: cotizacion.lineas,
      totales: {
        subtotal: cotizacion.subtotal,
        ahorro: cotizacion.ahorro,
        tasaIva: cotizacion.tasaIva,
        iva: cotizacion.iva,
        total: cotizacion.total,
        // Sin columna propia: viaja dentro del jsonb para que la Tarea 7 sepa
        // si el Estimate debe llevar la nota de "precio a confirmar contra
        // muestra". Sin esto, reimprimir la cotización meses después perdería
        // esa condición y el documento parecería un precio en firme que
        // nunca lo fue.
        bordadoEspecial: cotizacion.bordadoEspecial,
      },
    })
    .select()
    .single();

  if (error) {
    console.error('[cotizador] No se pudo guardar la cotización.', error.message);
    return NextResponse.json({ ok: false, error: 'No se pudo guardar.' }, { status: 500 });
  }

  // Ronda de correcciones 2 (hallazgo I1): si esta cotización nació de un
  // borrador que dejó el agente de IA, esa fila hay que cerrarla ya —
  // independiente de cómo le vaya a GoHighLevel más abajo. La cotización
  // real (esta que se acaba de guardar) ya existe: dejar el borrador en
  // 'borrador' para siempre es lo que hoy nunca vacía la cola del vendedor
  // y, peor, bloquea `registrarIntencion` (lib/cotizador/borrador.ts) para
  // este contacto de por vida, porque esa función corta si ya hay un
  // 'borrador' abierto suyo. Best-effort: un fallo acá se registra pero no
  // debe tumbar la respuesta, la cotización ya está a salvo.
  if (datos.borradorId) {
    const { error: errorBorrador } = await supabaseAdmin()
      .from('cotizaciones')
      .update({ estado: 'convertida', updated_at: new Date().toISOString() })
      .eq('id', datos.borradorId);
    if (errorBorrador) {
      console.error('[cotizador] No se pudo cerrar el borrador del agente.', errorBorrador.message);
    }
  }

  const ghl = await crearEstimate(
    { cotizacion, cliente: datos.cliente, contactId: datos.contactId },
    {
      apiKey: process.env.LUXE_GHL_API_KEY ?? '',
      locationId: process.env.LUXE_GHL_LOCATION_ID ?? '',
    },
  );

  // El contactId se guarda aunque GoHighLevel haya fallado después: si el
  // contacto se llegó a resolver (recibido del vendedor, o recién creado por
  // `crearEstimate`), es un dato gratis que ya tenemos en la mano y que de
  // otro modo se pierde sin dejar rastro en la fila.
  const contactId = ghl.contactId ?? datos.contactId ?? null;

  // El registro ya existe pase lo que pase. Aquí solo se anota cómo le fue al
  // CRM: una cotización con ghl_error es recuperable, igual que un lead.
  const { error: errorActualizacion } = await supabaseAdmin()
    .from('cotizaciones')
    .update(
      // `updated_at` va explícito: la columna tiene `default now()` pero no hay
      // trigger, así que sin esto se quedaría siempre igual a `created_at` y la
      // auditoría diría que la cotización nunca cambió de estado.
      // Ronda de correcciones 2 (hallazgo C1): 'creada', no 'enviada'.
      // `crearEstimate` (lib/cotizador/ghl.ts) nunca llama al endpoint de
      // envío de GoHighLevel — el Estimate queda en `draft` ahí adentro
      // hasta que alguien lo abra y lo mande a mano. 'enviada' se queda en
      // el check de la tabla para cuando ese envío exista de verdad.
      ghl.ok
        ? {
            estado: 'creada',
            ghl_estimate_id: ghl.estimateId,
            ghl_error: ghl.opportunityError ?? null,
            contact_id: contactId,
            updated_at: new Date().toISOString(),
          }
        : {
            estado: 'error',
            ghl_error: ghl.error,
            contact_id: contactId,
            updated_at: new Date().toISOString(),
          },
    )
    .eq('id', data.id);

  if (errorActualizacion) {
    // El Estimate (y la Opportunity) ya se gestionaron en GoHighLevel en este
    // punto — esto no invalida ese resultado. Pero si esto falla en
    // silencio, la fila queda parada en 'borrador' sin `ghl_estimate_id`
    // pese a que el Estimate sí existe: el mismo huérfano que "primero
    // Supabase" evita, corrido un paso más adelante. Se registra para que
    // sea recuperable a mano.
    console.error(
      '[cotizador] El Estimate se gestionó en GoHighLevel pero no se pudo actualizar la fila.',
      errorActualizacion.message,
    );
  }

  return NextResponse.json({
    ok: true,
    id: data.id,
    cotizacion,
    ghl: ghl.ok ? { estimateId: ghl.estimateId } : { error: ghl.error },
  });
}
