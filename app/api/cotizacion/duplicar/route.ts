import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// Ruta dedicada de solo lectura para "Duplicar" (Tarea 10). `/listado`
// deja fuera `lineas` a propósito (ver su propio comentario: son muchos
// datos por fila, y la lista no los necesita) — pero para duplicar una
// cotización el vendedor SÍ necesita, de una sola fila puntual, qué SKUs y
// qué cantidades llevaba. Esta ruta pide esa columna para un único id y
// devuelve nada más que `skuId`/`cantidad` por línea: nunca `precioLista`,
// `precioUnitario`, `descuentoPct` ni `motivo` — esos son historia de la
// cotización vieja, no del pedido que se está por rearmar. La cotización
// nueva vuelve a calcular sus precios desde cero, con la lista vigente hoy,
// vía `/api/cotizacion/previsualizar` — igual que si el vendedor hubiera
// tecleado los SKUs a mano.
const duplicarSchema = z.object({
  clave: z.string().optional(),
  // Mismo motivo que en /cerrar y /reenviar: un id sin forma de UUID
  // revienta en Postgres como 500 en vez de 400.
  id: z.uuid('El id de la cotización no es válido.'),
});

type LineaGuardada = { skuId?: unknown; cantidad?: unknown };

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // La credencial se revisa antes que el esquema: mismo motivo que en el
  // resto de app/api/cotizacion/*. Ruta de solo lectura (SELECT): no exige
  // el token anti-CSRF, igual que /listado, /metricas y /borradores.
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: false });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const parseado = duplicarSchema.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }
  const datos = parseado.data;

  const { data: fila, error } = await supabaseAdmin()
    .from('cotizaciones')
    .select('lineas')
    .eq('id', datos.id)
    .maybeSingle();

  if (error) {
    console.error('[cotizador] No se pudo consultar la cotización a duplicar.', error.message);
    return NextResponse.json({ ok: false, error: 'No se pudo consultar.' }, { status: 500 });
  }

  if (!fila) {
    return NextResponse.json({ ok: false, error: 'Cotización no encontrada.' }, { status: 404 });
  }

  // Defensivo: si el jsonb guardado alguna vez no tuviera la forma
  // esperada (fila vieja, migración incompleta), se devuelve una lista
  // vacía en vez de reventar — el vendedor puede seguir armando la
  // cotización a mano, igual que si hubiera elegido "Crear" desde cero.
  const crudas = Array.isArray((fila as { lineas?: unknown }).lineas)
    ? ((fila as { lineas: LineaGuardada[] }).lineas)
    : [];
  const lineas = crudas
    .filter((l) => typeof l.skuId === 'string' && typeof l.cantidad === 'number' && l.cantidad > 0)
    .map((l) => ({ skuId: l.skuId as string, cantidad: l.cantidad as number }));

  return NextResponse.json({ ok: true, lineas });
}
