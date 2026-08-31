import { NextResponse } from 'next/server';
import { z } from 'zod';
import { huellaDe } from '@/lib/cotizador/invitaciones';
import { hashClave } from '@/lib/cotizador/credenciales.mjs';
import { emitirSesion } from '@/lib/sesion';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// La única ruta del panel sin sesión previa: quien la llama todavía no
// existe como sesión de nadie. Por eso es la más expuesta de todo el
// sistema, y por eso el mismo cuidado que `entrar/route.ts` le da a la
// tabla de credenciales se repite acá con la tabla de invitaciones.
const Entrada = z.object({
  enlace: z.string().min(1, 'Falta el enlace.'),
  clave: z.string().min(10, 'La clave debe tener al menos 10 caracteres.').max(200),
});

// Enlace inexistente, vencido, o cuenta desactivada: los tres dan exactamente
// el mismo 400 con el mismo texto. Si se distinguieran, alguien podría
// probar enlaces al azar (o correos filtrados de otro lado) y usar la
// respuesta para averiguar qué correos tienen una invitación esperando —
// exactamente el mismo motivo por el que `autenticarUsuario` (Tarea 2) no
// distingue "no existe" de "clave incorrecta".
const MENSAJE_ENLACE_INVALIDO =
  'Este enlace ya venció o no es válido. Pedile a tu administrador que te mande uno nuevo.';

type FilaInvitacion = {
  id: string;
  nombre: string;
  rol: 'vendedor' | 'superadmin';
  activo: boolean;
  invitacion_expira: string | null;
};

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  const parseado = Entrada.safeParse(crudo);
  if (!parseado.success) {
    const mensajeClave = parseado.error.flatten().fieldErrors.clave?.[0];
    return NextResponse.json(
      { ok: false, error: mensajeClave ?? 'Faltan datos.' },
      { status: 400 },
    );
  }

  const db = supabaseAdmin();
  // Se busca por la HUELLA, nunca por el enlace: el valor crudo del enlace
  // no debe aparecer jamás en una consulta ni en un log. `huellaDe` es la
  // misma función (Tarea 1) con la que se guardó al invitar — es una
  // igualdad indexada en la base, no una comparación en la aplicación.
  const huella = huellaDe(parseado.data.enlace);

  let fila: FilaInvitacion | null;
  try {
    const { data, error } = await db
      .from('usuarios_panel')
      .select('id, nombre, rol, activo, invitacion_expira')
      .eq('invitacion_hash', huella)
      .maybeSingle();
    if (error) throw new Error(error.message);
    fila = data as FilaInvitacion | null;
  } catch (err) {
    console.error(
      '[cotizador] No se pudo leer la invitación al fijar la clave.',
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      { ok: false, error: 'No pudimos procesar tu enlace. Intentá de nuevo en un momento.' },
      { status: 500 },
    );
  }

  const vencida =
    !fila?.invitacion_expira || new Date(fila.invitacion_expira).getTime() <= Date.now();

  // Nunca decir cuál de los tres casos fue: sin fila, vencida, o desactivada
  // caen en la misma respuesta.
  if (!fila || vencida || !fila.activo) {
    return NextResponse.json({ ok: false, error: MENSAJE_ENLACE_INVALIDO }, { status: 400 });
  }

  let claveHash: string;
  let claveSal: string;
  try {
    const derivado = await hashClave(parseado.data.clave);
    claveHash = derivado.hash;
    claveSal = derivado.sal;
  } catch (err) {
    console.error(
      '[cotizador] No se pudo derivar el hash de la clave nueva.',
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      { ok: false, error: 'No pudimos guardar tu clave. Intentá de nuevo en un momento.' },
      { status: 500 },
    );
  }

  try {
    // El enlace es de un solo uso: `invitacion_hash` e `invitacion_expira`
    // quedan en null en la MISMA escritura que fija la clave. Si no, quien
    // conserve el correo podría volver a fijar la clave más adelante y
    // entrar cuando quiera. `intentos`/`bloqueado_hasta` en cero arrancan la
    // cuenta limpia, igual que hace `autenticarUsuario` al entrar bien.
    const { error } = await db
      .from('usuarios_panel')
      .update({
        clave_hash: claveHash,
        clave_sal: claveSal,
        invitacion_hash: null,
        invitacion_expira: null,
        intentos: 0,
        bloqueado_hasta: null,
        ultimo_acceso: new Date().toISOString(),
      })
      .eq('id', fila.id);
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(
      '[cotizador] No se pudo guardar la clave nueva.',
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      { ok: false, error: 'No pudimos guardar tu clave. Intentá de nuevo en un momento.' },
      { status: 500 },
    );
  }

  try {
    const { cookie, csrf } = emitirSesion(fila.nombre, fila.rol);
    const respuesta = NextResponse.json({
      ok: true,
      csrf,
      vendedor: fila.nombre,
      rol: fila.rol,
    });
    respuesta.headers.set('Set-Cookie', cookie);
    return respuesta;
  } catch (err) {
    console.error(
      '[cotizador] No se pudo emitir la sesión tras fijar la clave. ¿Falta LUXE_SESION_SECRETO?',
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      { ok: false, error: 'No pudimos abrir tu sesión. Avisale a quien administra el sitio.' },
      { status: 500 },
    );
  }
}
