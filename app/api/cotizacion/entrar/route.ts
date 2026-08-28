import { NextResponse } from 'next/server';
import { claveValida } from '@/lib/autenticacion-cotizador';
import { emitirSesion } from '@/lib/sesion';

export const runtime = 'nodejs';

// Único punto de entrada del panel embebido: la pantalla dentro del iframe de
// GoHighLevel pide la clave una vez acá, cambia esa clave por una cookie de
// sesión (Tarea 6) y ya no vuelve a pedirla en cada carga. Las demás rutas de
// este directorio siguen aceptando la clave en el cuerpo tal cual — esto no
// la reemplaza, es una segunda forma de autenticarse. A diferencia de esas
// rutas, esta no acepta una sesión ya abierta: es precisamente donde una se
// consigue.
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
  if (!claveValida(claveRecibida)) {
    // Ronda de correcciones 1: no hay límite de intentos acá —eso necesita
    // almacenamiento compartido entre invocaciones y es otro subsistema—,
    // pero sin este registro un intento de fuerza bruta contra este endpoint
    // es completamente invisible. Sin datos sensibles: ni la clave recibida
    // ni la esperada quedan en el log, solo la señal de que alguien golpeó
    // la puerta sin la llave correcta.
    console.error(
      '[cotizador] Intento de acceso a /api/cotizacion/entrar con clave incorrecta.',
      request.headers.get('x-forwarded-for') ?? 'ip desconocida',
    );
    return NextResponse.json({ ok: false, error: 'Clave incorrecta.' }, { status: 401 });
  }

  const { cookie, csrf } = emitirSesion();
  const respuesta = NextResponse.json({ ok: true, csrf });
  respuesta.headers.set('Set-Cookie', cookie);
  return respuesta;
}
