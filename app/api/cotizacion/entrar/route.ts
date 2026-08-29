import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { autenticarUsuario } from '@/lib/cotizador/usuarios';
import { emitirSesion } from '@/lib/sesion';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// Único punto de entrada del panel embebido. Hasta la fase 2 cambiaba una clave
// compartida por una cookie; ahora cambia la credencial de una persona.
// `LUXE_TALLER_CLAVE` sigue existiendo, pero sólo como clave de `/q7m4`: ya no
// abre el panel ni firma nada (revisión final, Crítico 1 — la cookie se firma
// con `LUXE_SESION_SECRETO`).
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
    // El usuario NO se registra, ni entero ni truncado: el modo de fallo más
    // común de un formulario de acceso es que la persona escriba la clave en
    // el campo de usuario por error, y en ese caso hasta un prefijo de tres
    // caracteres deja pedazos de una clave real en los logs de Vercel,
    // retenidos y buscables (revisión final, M5).
    //
    // Lo único que esta línea necesita es poder distinguir intentos contra
    // cuentas distintas —"¿son cien intentos contra una cuenta o uno contra
    // cien?"— y para eso un hash corto hace exactamente el mismo trabajo con
    // fuga cero. No es un secreto que haya que proteger contra fuerza bruta:
    // es una etiqueta estable para agrupar líneas de log.
    console.error(
      '[cotizador] Entrada rechazada al panel.',
      'usuario (hash):', createHash('sha256').update(parseado.data.usuario).digest('hex').slice(0, 8),
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

  // Revisión final, M7: esto estaba fuera de todo `try`. `emitirSesion` lanza
  // si `LUXE_SESION_SECRETO` falta —el caso exacto de un despliegue nuevo al
  // que se le olvidó la variable— y sin este bloque Next devolvía un 500
  // genérico, sin una sola línea que dijera por qué. El síntoma sería
  // "entramos bien y no pasa nada", con la causa a la vista sólo para quien
  // fuera a leer el código.
  try {
    const { cookie, csrf } = emitirSesion(resultado.nombre);
    const respuesta = NextResponse.json({ ok: true, csrf, vendedor: resultado.nombre });
    respuesta.headers.set('Set-Cookie', cookie);
    return respuesta;
  } catch (err) {
    console.error(
      '[cotizador] No se pudo emitir la sesión del panel. ¿Falta LUXE_SESION_SECRETO?',
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      { ok: false, error: 'No pudimos abrir tu sesión. Avisale a quien administra el sitio.' },
      { status: 500 },
    );
  }
}
