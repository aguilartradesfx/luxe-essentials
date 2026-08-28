import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { calcularMetricas, type FilaCotizacion } from '@/lib/cotizador/metricas';

export const runtime = 'nodejs';

// Las columnas que `calcularMetricas` (Tarea 7) necesita para calcular las
// seis métricas: incluye `lineas` (a diferencia de /listado) porque de ahí
// sale el reparto por producto y por línea de negocio.
const COLUMNAS = 'id, created_at, enviado_at, cerrada_at, estado, origen, cliente, lineas, totales';

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
  const { data, error } = await supabaseAdmin().from('cotizaciones').select(COLUMNAS);

  if (error) {
    console.error('[cotizador] No se pudieron leer las cotizaciones para las métricas.', error.message);
    return NextResponse.json({ ok: false, error: 'No se pudo consultar.' }, { status: 500 });
  }

  const metricas = calcularMetricas((data ?? []) as FilaCotizacion[], new Date());

  return NextResponse.json({ ok: true, metricas });
}
