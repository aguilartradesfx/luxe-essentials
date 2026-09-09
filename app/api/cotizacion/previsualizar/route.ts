import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { previsualizarSchema, previsualizarPendienteSchema } from '@/lib/validation';
import { calcular } from '@/lib/cotizador/calcular';
import { CATALOGO } from '@/lib/cotizador/catalogo';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { previsualizarPendiente, SIN_PERMISO_APROBAR } from '@/lib/cotizador/aprobacion';

export const runtime = 'nodejs';

// Tarea 8: la pantalla ya no tiene el catálogo (ni `calcular`) en el
// navegador, así que la vista previa —lo que antes era un `useMemo` local—
// pasa a ser esta llamada, con el mismo motor y el mismo catálogo que usa el
// envío final en app/api/cotizacion/route.ts. Sin persistencia: no escribe
// nada, solo devuelve el cálculo.
export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // La credencial se revisa antes que el esquema: mismo motivo que en
  // app/api/cotizacion/route.ts — no filtrar la forma del cuerpo a quien no
  // tiene credencial. Ruta de solo lectura: no persiste nada, no exige el
  // token anti-CSRF.
  const auth = await autenticarPeticion(request, crudo, { requiereCsrf: false });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  // I3, cabo suelto: dos vistas previas distintas viven en esta ruta.
  //
  //   - Sin `cotizacionId` (VistaCrear): el vendedor está ARMANDO una
  //     cotización nueva, así que el precio correcto es el de HOY --
  //     `CATALOGO`, como siempre.
  //   - Con `cotizacionId` (VistaAprobaciones): el superadmin está mirando
  //     una solicitud que puede llevar días esperando, y el precio correcto
  //     es el CONGELADO en esa fila -- el mismo que va a usar `aprobar()`.
  //     Si acá se usara `CATALOGO`, el total que el superadmin mira antes de
  //     decidir y el que sale en el PDF serían dos números distintos.
  //
  // La fila se lee de la base por su id: nunca se confía en unas `lineas`
  // que mande el navegador (ver el comentario de `previsualizarPendiente`).
  const conId = crudo as { cotizacionId?: unknown };
  if (typeof conId?.cotizacionId === 'string') {
    const db = supabaseAdmin();
    // Ver una cotización ajena pendiente -- con sus totales -- es lo mismo
    // que puede hacer `/pendientes`, y exige lo mismo: superadmin releído
    // de la base, nunca el rol de la cookie.
    const autorizacion = await autorizarSuperadmin(auth.id, db);
    if (!autorizacion.ok) {
      return NextResponse.json({ ok: false, error: SIN_PERMISO_APROBAR }, { status: 403 });
    }

    const parseadoPendiente = previsualizarPendienteSchema.safeParse(crudo);
    if (!parseadoPendiente.success) {
      return NextResponse.json(
        { ok: false, error: parseadoPendiente.error.issues[0]?.message ?? 'Datos inválidos.' },
        { status: 400 },
      );
    }

    const resultado = await previsualizarPendiente(
      parseadoPendiente.data.cotizacionId,
      parseadoPendiente.data.descuentoPersonalizado,
      db,
    );
    if (!resultado.ok) {
      return NextResponse.json({ ok: false, error: resultado.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, cotizacion: resultado.cotizacion });
  }

  const parseado = previsualizarSchema.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }
  const datos = parseado.data;

  // `calcular` lanza si un SKU no existe o la cantidad es absurda. Igual que
  // en el envío final, eso es un error del cliente: se traduce a 400.
  //
  // Fase 5 (descuento con aprobación), corrección: `descuentoPersonalizado`
  // faltaba acá -- el esquema ya lo validaba (`previsualizarSchema`) pero
  // nunca llegaba a `calcular`, así que la vista previa mostraba el
  // descuento de escala de siempre aunque el vendedor hubiera pedido uno
  // personalizado. `VistaCrear` (app/cotizador/VistaCrear.tsx) depende de
  // este campo para mostrar el efecto ANTES de enviar -- sin él, el
  // vendedor no tiene forma de ver qué va a pasar hasta después de mandar
  // la cotización de verdad.
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

  return NextResponse.json({ ok: true, cotizacion });
}
