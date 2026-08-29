import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarUsuario } from '@/lib/cotizador/usuarios';
import { emitirSesion } from '@/lib/sesion';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// Único punto de entrada del panel embebido. Hasta la fase 2 cambiaba una clave
// compartida por una cookie; ahora cambia la credencial de una persona. La
// clave compartida (`LUXE_TALLER_CLAVE`) sigue existiendo, pero sólo como
// secreto de firma de esa cookie y como clave de `/q7m4`: ya no abre el panel.
const Entrada = z.object({
  usuario: z.string().trim().min(1, 'Falta el usuario.').max(64),
  clave: z.string().min(1, 'Falta la clave.').max(200),
});

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  const parseado = Entrada.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: 'Escribí tu usuario y tu clave.' },
      { status: 400 },
    );
  }

  let resultado;
  try {
    resultado = await autenticarUsuario(
      parseado.data.usuario,
      parseado.data.clave,
      supabaseAdmin(),
    );
  } catch (err) {
    // Un fallo de base es un 500, no un 401: decirle "clave incorrecta" a un
    // vendedor cuya credencial es correcta lo manda a buscar el problema donde
    // no está, y esconde una caída real.
    console.error(
      '[cotizador] No se pudo autenticar contra la tabla de usuarios.',
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      { ok: false, error: 'No pudimos verificar tu acceso. Intentá de nuevo en un momento.' },
      { status: 500 },
    );
  }

  if (!resultado.ok) {
    // El usuario NO se registra completo: el modo de fallo más común de un
    // formulario de acceso es que la persona escriba la clave en el campo de
    // usuario por error. Si eso pasa acá, la clave real de un vendedor
    // quedaría en texto plano en los logs de Vercel, retenida y buscable.
    // Los primeros 3 caracteres alcanzan para distinguir intentos contra
    // cuentas distintas sin exponer una credencial completa.
    console.error(
      '[cotizador] Entrada rechazada al panel.',
      'usuario (primeros 3 caracteres):', parseado.data.usuario.slice(0, 3),
      'motivo:', resultado.motivo,
      request.headers.get('x-forwarded-for') ?? 'ip desconocida',
    );
    // El bloqueo se dice tal cual. Confirma que la cuenta existe, sí — pero el
    // nombre de usuario de un equipo de cinco personas no es el secreto, la
    // clave lo es; y un vendedor bloqueado que no puede distinguirlo de "clave
    // mala" seguiría probando hasta rendirse.
    if (resultado.motivo === 'bloqueado') {
      return NextResponse.json(
        { ok: false, error: 'Cuenta bloqueada por intentos fallidos. Probá en 15 minutos.' },
        { status: 429 },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'Usuario o clave incorrectos.' },
      { status: 401 },
    );
  }

  const { cookie, csrf } = emitirSesion(resultado.nombre);
  const respuesta = NextResponse.json({ ok: true, csrf, vendedor: resultado.nombre });
  respuesta.headers.set('Set-Cookie', cookie);
  return respuesta;
}
