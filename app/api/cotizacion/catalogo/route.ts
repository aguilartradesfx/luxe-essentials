import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { sesionValida } from '@/lib/sesion';
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

// Tarea 8: este es el único lugar donde el catálogo completo (con
// `precioLista` y `grupo`, la estructura de márgenes por volumen) toca el
// servidor de cara a la pantalla. Lo que sale de acá hacia el navegador es
// deliberadamente angosto: ni precios ni grupo de descuento, solo lo que el
// vendedor necesita para buscar y elegir un SKU. `/api/cotizacion/previsualizar`
// es quien calcula con el catálogo real, siempre en el servidor.
export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // La clave (o la sesión) se revisa antes de tocar el resto del cuerpo: no
  // hay esquema que validar aquí (solo se espera `clave`), pero el orden se
  // mantiene igual que en los otros endpoints de este directorio por
  // consistencia. Ruta de solo lectura: no exige el token anti-CSRF, ese
  // requisito es de las que escriben (app/api/cotizacion/route.ts).
  const claveRecibida =
    typeof crudo === 'object' && crudo !== null && 'clave' in crudo
      ? (crudo as { clave?: unknown }).clave
      : undefined;
  if (!claveValida(typeof claveRecibida === 'string' ? claveRecibida : null) && !sesionValida(request)) {
    return NextResponse.json({ ok: false, error: 'Clave incorrecta.' }, { status: 401 });
  }

  const skus = CATALOGO.map((sku) => ({ id: sku.id, nombre: sku.nombre, familia: sku.familia }));

  return NextResponse.json({ ok: true, skus });
}
