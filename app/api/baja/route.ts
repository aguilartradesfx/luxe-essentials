import { NextResponse } from 'next/server';
import { correoDeToken } from '@/lib/campanas/baja';
import { registrarBaja } from '@/lib/campanas/exclusiones';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// El endpoint de la baja de un clic que RFC 8058 exige desde 2024 para que
// Gmail y Yahoo no penalicen la entrega de un envío masivo (ver el pie de
// `lib/campanas/baja.ts`, `cabecerasListaBaja`). A esta ruta NUNCA llega una
// persona: la llama el propio servidor de Gmail o Yahoo cuando alguien toca
// "Cancelar suscripción" en su cliente de correo, con un POST directo a la
// URL de la cabecera `List-Unsubscribe` -- sin pantalla, sin clic dentro del
// sitio. Por eso vive en /api/baja y no en /baja (la página pública, Tarea
// 2): ese POST no puede pasar por una pantalla de confirmación que nadie va
// a ver.
//
// Es pública y no lleva token anti-CSRF: quien la llama es el servidor de
// Gmail, no un navegador con una sesión que proteger, así que no hay cookie
// que un sitio ajeno pudiera aprovechar. Toda la seguridad de esta ruta es
// la firma del token -- por eso `correoDeToken` (HMAC + comparación en
// tiempo constante, ver lib/campanas/baja.ts) es la única puerta antes de
// escribir en la tabla de bajas.
export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get('t') ?? '';
  const correo = correoDeToken(token);

  // Nunca se distingue por qué falló (token ausente, mal formado, o firmado
  // con una clave que ya no es la vigente): en los tres casos no hay a quién
  // dar de baja. RFC 8058 no exige un cuerpo en particular en la respuesta,
  // así que este 400 es sólo para quien inspeccione la ruta a mano.
  if (!correo) {
    return NextResponse.json({ ok: false, error: 'Enlace inválido.' }, { status: 400 });
  }

  const db = supabaseAdmin();
  const resultado = await registrarBaja(correo, 'un_clic', db);
  if (!resultado.ok) {
    console.error('[baja] No se pudo registrar la baja de un clic (RFC 8058).', resultado.error);
    return NextResponse.json({ ok: false, error: 'No se pudo procesar la baja.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
