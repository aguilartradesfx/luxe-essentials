import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { previsualizarSchema } from '@/lib/validation';
import { calcular } from '@/lib/cotizador/calcular';
import { CATALOGO } from '@/lib/cotizador/catalogo';

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
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: false });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
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
