import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { calcularMetricas, type FilaCotizacion } from '@/lib/cotizador/metricas';

export const runtime = 'nodejs';

// Las columnas que `calcularMetricas` (Tarea 7) necesita para calcular las
// seis métricas: incluye `lineas` (a diferencia de /listado) porque de ahí
// sale el reparto por producto y por línea de negocio.
const COLUMNAS = 'id, created_at, enviado_at, cerrada_at, estado, origen, cliente, lineas, totales';

// Ronda de correcciones 1 (Tarea 8, hallazgo importante): la API de
// Supabase/PostgREST trunca en silencio a partir de 1000 filas por defecto,
// y sin `order` explícito el corte cae en un orden arbitrario del motor —
// hoy la tabla está casi vacía, así que nunca se nota, pero es exactamente
// el tipo de error que solo aparece cuando el negocio crece, en el peor
// momento para descubrirlo. Este tope es una red explícita, no la solución
// de fondo: si `cotizaciones` supera `MAX_FILAS`, las métricas empiezan a
// excluir en silencio las filas más antiguas (el `order` deja las más
// recientes primero, así que el corte se lleva lo de atrás). El día que
// haga falta, la solución real es agregar filtro de rango de fechas al
// panel, no subir este número.
const MAX_FILAS = 5000;

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // La credencial se revisa antes que nada, mismo motivo que en el resto de
  // app/api/cotizacion/*. Ruta de solo lectura: no exige el token anti-CSRF.
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: false });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  // Sin filtrar por estado: `calcularMetricas` decide caso por caso qué
  // estados cuentan para cada número (Tarea 7, `ESTADOS_REALES`). Filtrar acá
  // duplicaría ese criterio en dos lugares que podrían desalinearse.
  const { data, error } = await supabaseAdmin()
    .from('cotizaciones')
    .select(COLUMNAS)
    .order('created_at', { ascending: false })
    .limit(MAX_FILAS);

  if (error) {
    console.error('[cotizador] No se pudieron leer las cotizaciones para las métricas.', error.message);
    return NextResponse.json({ ok: false, error: 'No se pudo consultar.' }, { status: 500 });
  }

  const metricas = calcularMetricas((data ?? []) as FilaCotizacion[], new Date());

  return NextResponse.json({ ok: true, metricas });
}
