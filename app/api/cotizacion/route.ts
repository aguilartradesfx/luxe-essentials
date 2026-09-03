import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { cotizacionSchema } from '@/lib/validation';
import { calcular } from '@/lib/cotizador/calcular';
import { CATALOGO } from '@/lib/cotizador/catalogo';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { enviarCotizacionAlHotel, ESTADOS_MODIFICABLES } from '@/lib/cotizador/enviar';
import { avisarSolicitudAprobacion } from '@/lib/cotizador/aprobacion';

export const runtime = 'nodejs';

// Ronda de correcciones final (hallazgo importante): es la única ruta de
// app/api/cotizacion/* que escribe sin declarar `maxDuration` — y la que más
// tiempo puede tomar: insert, hasta cuatro llamadas HTTP a GoHighLevel,
// render del PDF, subida a Storage, firma del enlace, correo con adjunto por
// Resend y nota en el contacto, antes del update final. Sin esto, la función
// corre con el límite por defecto de Vercel (10 s) — corto de sobra para esa
// cadena — y si expira a mitad, la fila queda parada en 'borrador': no
// aparece en fallidas (esas son 'error'), `/cerrar` la rechaza (no está en
// `ESTADOS_CIERRE_INICIAL`) y `/reenviar` también (no tiene `pdf_ruta`). Un
// huérfano sin salida. Mismo criterio que app/api/ghl/webhook/route.ts, que
// enfrenta el mismo problema con una cadena de llamadas de red parecida.
//
// Fase 5 (descuento con aprobación): cuando la cotización queda
// 'esperando_aprobacion' esta ruta corta mucho antes de llegar a nada de
// esto (ni GoHighLevel, ni PDF, ni correo al cliente) -- ese camino es
// rápido. El camino largo que este límite protege sigue siendo el mismo de
// siempre: crear y enviar directo, y (fase 5) aprobar una que esperaba, en
// app/api/cotizacion/aprobar/route.ts, que declara el mismo `maxDuration`
// por el mismo motivo.
export const maxDuration = 60;

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // La credencial se revisa antes que el esquema: si alguien sin ella manda
  // un cuerpo mal formado, no debe recibir mensajes de validación que
  // revelen la forma esperada del cuerpo. Mismo orden que app/api/q7m4/route.ts.
  // Esta ruta escribe (inserta la cotización): `requiereCsrf: true` exige el
  // token anti-CSRF cuando se entra por cookie (ver lib/autenticacion-cotizador.ts).
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
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
      descuentoPersonalizado: datos.descuentoPersonalizado,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'No se pudo calcular.' },
      { status: 400 },
    );
  }

  // Fase 5 (descuento con aprobación): `auth.rol` sale de la cookie y NO
  // AUTORIZA NADA -- es un dato viejo desde el momento en que se firmó la
  // sesión, hasta 30 días (ver lib/autenticacion-cotizador.ts). Sólo se
  // relee la base cuando de verdad hace falta decidir algo con eso: cuando
  // la cotización trae un descuento personalizado. Mismo patrón que las
  // cuatro rutas de app/api/equipo/* con `autorizarSuperadmin`
  // (lib/cotizador/equipo.ts) -- se reutiliza esa misma función en vez de
  // reimplementar la relectura acá.
  let autorizacionSuperadmin: { ok: true; id: string } | { ok: false } = { ok: false };
  if (datos.descuentoPersonalizado) {
    autorizacionSuperadmin = await autorizarSuperadmin(auth.id, supabaseAdmin());
  }
  // Toda cotización con descuento personalizado pasa por aprobación (diseño:
  // "sin umbral"), salvo que quien la arma YA sea superadmin (diseño: "un
  // superadmin no se pide permiso a sí mismo").
  const requiereAprobacion = Boolean(datos.descuentoPersonalizado) && !autorizacionSuperadmin.ok;

  // "Modificar": se relee la cotización vieja ACÁ, fresca -- en vez de
  // confiar en lo que mandó el navegador (que ya trae `numero`/
  // `contact_id`/`estado` desde el listado, pero es una foto que pudo
  // quedar vieja desde que se cargó la pantalla). Esto evita que una fila
  // 'ganada'/'perdida'/'reemplazada' (o borrada a mano) reciba un
  // "reemplazo" que no debería existir, y es la fuente de verdad del
  // `numero` y el `contact_id` que se guardan más abajo -- nunca lo que
  // mande el cliente. Si algo de esto falla, se corta ACÁ: nada se inserta,
  // no hay Estimate, no hay PDF ni correo. "No debe quedar nada a medias."
  let filaReemplazada: { estado: string; numero: string; contact_id: string | null } | null = null;
  if (datos.reemplazaId) {
    const { data: filaVieja, error: errorVieja } = await supabaseAdmin()
      .from('cotizaciones')
      .select('estado, numero, contact_id')
      .eq('id', datos.reemplazaId)
      .maybeSingle();

    if (errorVieja) {
      console.error('[cotizador] No se pudo consultar la cotización a reemplazar.', errorVieja.message);
      return NextResponse.json({ ok: false, error: 'No se pudo consultar.' }, { status: 500 });
    }
    if (!filaVieja) {
      return NextResponse.json({ ok: false, error: 'La cotización a reemplazar no existe.' }, { status: 404 });
    }
    if (!ESTADOS_MODIFICABLES.includes(filaVieja.estado)) {
      return NextResponse.json(
        { ok: false, error: `No se puede modificar una cotización en estado "${filaVieja.estado}".` },
        { status: 409 },
      );
    }
    filaReemplazada = filaVieja;
  }

  // Se calcula ACÁ, antes del insert -- no depende de la fila recién creada,
  // sólo de lo que mandó el vendedor y de la relectura de arriba. Fase 5: si
  // la cotización queda esperando aprobación, este es el único momento en
  // que este dato está a mano -- la aprobación real puede llegar días
  // después, en otra petición, sin `datos.contactId` disponible.
  const contactIdEntrada = datos.contactId ?? filaReemplazada?.contact_id ?? undefined;

  // Primero la base, después GoHighLevel (Tarea 7). Si el CRM falla, la
  // cotización sigue existiendo y es recuperable; al revés, el cliente tendría
  // una cotización que Luxe no registró.
  const { data, error } = await supabaseAdmin()
    .from('cotizaciones')
    .insert({
      // Ronda de correcciones final (hallazgo crítico): antes esto era
      // siempre 'humano', incluso cuando `datos.borradorId` probaba que la
      // cotización nació de un borrador que dejó el agente de WhatsApp. Como
      // esas filas quedan en 'convertida' (ver el update de abajo) y
      // `calcularMetricas` (lib/cotizador/metricas.ts) excluye ese estado de
      // todo, `porOrigen.agente` salía en cero siempre — la métrica de
      // "Origen" (Métricas #6) le decía al vendedor que el agente no aporta
      // nada, aunque toda la cotización viniera de él.
      origen: datos.borradorId ? 'agente' : 'humano',
      // Fase 5: 'esperando_aprobacion' cuando el descuento personalizado
      // necesita el visto bueno de un superadmin; si no, 'borrador' de
      // siempre -- el resto de la ruta la lleva a 'enviada'/'error'.
      estado: requiereAprobacion ? 'esperando_aprobacion' : 'borrador',
      // Quién la armó. Se guarda el nombre y no el id del usuario a propósito:
      // dentro de un año esta fila tiene que seguir diciendo quién la hizo
      // aunque esa persona se haya dado de baja.
      vendedor: auth.vendedor,
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
      // "Modificar": sólo van si el envío viene de esa acción. `numero` sale
      // de `filaReemplazada` (la relectura de arriba), nunca de lo que
      // mandó el cliente -- ver el comentario grande junto a esa consulta.
      ...(datos.reemplazaId ? { reemplaza_a: datos.reemplazaId, reemplaza_a_numero: filaReemplazada!.numero } : {}),
      // Fase 5 (descuento con aprobación): columnas de la migración 0017.
      ...(datos.descuentoPersonalizado
        ? {
            descuento_personalizado: datos.descuentoPersonalizado,
            solicitado_por: auth.vendedor,
            ...(requiereAprobacion
              ? {
                  // La cotización queda congelada esperando -- guardarlo
                  // ACÁ es la única forma de que no se pierda: el `update`
                  // final que lo fija de verdad (dentro de
                  // `enviarCotizacionAlHotel`) sólo corre cuando la
                  // cotización sale de verdad, y para una que queda
                  // esperando eso puede ser días después, en otra petición
                  // que ya no tiene `datos.contactId` a mano.
                  contact_id: contactIdEntrada ?? null,
                }
              : {
                  // Diseño: "un superadmin no se pide permiso a sí mismo --
                  // igual queda registrado quién lo aprobó, él mismo, para
                  // que la trazabilidad no tenga huecos."
                  aprobado_por: auth.vendedor,
                  resuelto_at: new Date().toISOString(),
                  descuento_aprobado: datos.descuentoPersonalizado,
                }),
          }
        : {}),
    })
    .select()
    .single();

  if (error) {
    console.error('[cotizador] No se pudo guardar la cotización.', error.message);
    return NextResponse.json({ ok: false, error: 'No se pudo guardar.' }, { status: 500 });
  }

  // Ronda de correcciones 2 (hallazgo I1): si esta cotización nació de un
  // borrador que dejó el agente de IA, esa fila hay que cerrarla ya —
  // independiente de cómo le vaya a GoHighLevel más abajo (o, fase 5, de si
  // ésta queda esperando aprobación: la cotización REAL ya existe, sólo que
  // todavía no puede salir). Dejar el borrador en 'borrador' para siempre es
  // lo que hoy nunca vacía la cola del vendedor y, peor, bloquea
  // `registrarIntencion` (lib/cotizador/borrador.ts) para este contacto de
  // por vida, porque esa función corta si ya hay un 'borrador' abierto
  // suyo. Best-effort: un fallo acá se registra pero no debe tumbar la
  // respuesta, la cotización ya está a salvo.
  if (datos.borradorId) {
    const { error: errorBorrador } = await supabaseAdmin()
      .from('cotizaciones')
      .update({ estado: 'convertida', updated_at: new Date().toISOString() })
      .eq('id', datos.borradorId);
    if (errorBorrador) {
      console.error('[cotizador] No se pudo cerrar el borrador del agente.', errorBorrador.message);
    }
  }

  // Fase 5 (descuento con aprobación): la cotización queda congelada,
  // esperando. Nada de cara al hotel -- ni Estimate, ni PDF, ni correo con
  // el precio; eso sólo pasa cuando se aprueba (app/api/cotizacion/aprobar/route.ts,
  // que corre exactamente el mismo `enviarCotizacionAlHotel` de más abajo).
  // Lo único que sale de acá es el aviso a los superadmin -- mejor
  // esfuerzo, mismo criterio que `correo_error` en el resto de esta ruta:
  // un fallo del correo no tumba la operación, la cotización ya quedó
  // guardada y visible en el panel (diseño: "la pantalla es la fuente de
  // verdad").
  if (requiereAprobacion) {
    const avisoCorreo = await avisarSolicitudAprobacion(
      supabaseAdmin(),
      { apiKey: process.env.RESEND_API_KEY ?? '', remitente: process.env.LUXE_CORREO_REMITENTE ?? '' },
      {
        numero: data.numero,
        cliente: datos.cliente,
        total: cotizacion.total,
        descuentoPedido: datos.descuentoPersonalizado!,
        solicitadoPor: auth.vendedor,
      },
    );
    if (!avisoCorreo.ok) {
      console.error(
        '[cotizador] La cotización quedó esperando aprobación, pero el aviso a los superadmin no salió.',
        avisoCorreo.error,
      );
    }

    return NextResponse.json({
      ok: true,
      id: data.id,
      numero: data.numero,
      cotizacion,
      estado: 'esperando_aprobacion',
      aprobacion: { pendiente: true, avisoEnviado: avisoCorreo.ok },
    });
  }

  // Camino directo: sin descuento personalizado, o quien la arma ya es
  // superadmin. Misma cadena de siempre (Estimate/Opportunity, workflow,
  // PDF, correo, nota), extraída a lib/cotizador/enviar.ts porque
  // app/api/cotizacion/aprobar/route.ts (fase 5) también la necesita.
  const numero: string = data.numero;
  const resultadoEnvio = await enviarCotizacionAlHotel({
    id: data.id,
    numero,
    cotizacion,
    cliente: datos.cliente,
    contactIdEntrada,
    reemplazaId: datos.reemplazaId ?? null,
  });

  return NextResponse.json({
    ok: true,
    id: data.id,
    numero,
    cotizacion,
    ghl: resultadoEnvio.ghl,
    pdf: resultadoEnvio.pdf,
    correo: resultadoEnvio.correo,
    ...(datos.descuentoPersonalizado ? { aprobacion: { pendiente: false, autoAprobada: true } } : {}),
  });
}
