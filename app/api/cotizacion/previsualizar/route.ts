import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { sesionValida } from '@/lib/sesion';
import { previsualizarSchema } from '@/lib/validation';
import { calcular } from '@/lib/cotizador/calcular';
import { CATALOGO } from '@/lib/cotizador/catalogo';

export const runtime = 'nodejs';

// Mismo criterio que app/api/cotizacion/route.ts: comparación en tiempo constante.
function claveValida(recibida: string | null): boolean {
  const esperada = process.env.LUXE_TALLER_CLAVE;
  if (!esperada || !recibida) return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

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

  // La clave (o la sesión) se revisa antes que el esquema: mismo motivo que
  // en app/api/cotizacion/route.ts — no filtrar la forma del cuerpo a quien
  // no tiene credencial. Ruta de solo lectura: no persiste nada, no exige el
  // token anti-CSRF.
  const claveRecibida =
    typeof crudo === 'object' && crudo !== null && 'clave' in crudo
      ? (crudo as { clave?: unknown }).clave
      : undefined;
  if (!claveValida(typeof claveRecibida === 'string' ? claveRecibida : null) && !sesionValida(request)) {
    return NextResponse.json({ ok: false, error: 'Clave incorrecta.' }, { status: 401 });
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

  return NextResponse.json({ ok: true, cotizacion });
}
