import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { emitirSesion } from '@/lib/sesion';

export const runtime = 'nodejs';

// Mismo criterio que app/api/cotizacion/route.ts: comparación en tiempo
// constante y antes de tocar el resto del cuerpo.
function claveValida(recibida: string | null): boolean {
  const esperada = process.env.LUXE_TALLER_CLAVE;
  if (!esperada || !recibida) return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Único punto de entrada del panel embebido: la pantalla dentro del iframe de
// GoHighLevel pide la clave una vez acá, cambia esa clave por una cookie de
// sesión (Tarea 6) y ya no vuelve a pedirla en cada carga. Las demás rutas de
// este directorio siguen aceptando la clave en el cuerpo tal cual — esto no
// la reemplaza, es una segunda forma de autenticarse.
export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  const claveRecibida =
    typeof crudo === 'object' && crudo !== null && 'clave' in crudo
      ? (crudo as { clave?: unknown }).clave
      : undefined;
  if (!claveValida(typeof claveRecibida === 'string' ? claveRecibida : null)) {
    return NextResponse.json({ ok: false, error: 'Clave incorrecta.' }, { status: 401 });
  }

  const { cookie, csrf } = emitirSesion();
  const respuesta = NextResponse.json({ ok: true, csrf });
  respuesta.headers.set('Set-Cookie', cookie);
  return respuesta;
}
