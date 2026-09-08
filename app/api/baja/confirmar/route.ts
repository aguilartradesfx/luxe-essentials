import { NextResponse } from 'next/server';
import { z } from 'zod';
import { correoDeToken } from '@/lib/campanas/baja';
import { registrarBaja } from '@/lib/campanas/exclusiones';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// La acción explícita que ejecuta la baja después de que la persona vio la
// pantalla de /baja y tocó el botón (app/baja/PantallaBaja.tsx) -- distinta
// de app/api/baja/route.ts (la baja de un clic de Gmail/Yahoo, RFC 8058)
// para que la tabla `bajas_correo` pueda distinguir las dos vías (columna
// `via`, migración 0018): acá siempre 'pagina'.
//
// Pública y sin sesión, como la propia página: quien llega acá viene de un
// correo, no del panel. No exige token anti-CSRF por el mismo motivo que
// app/api/baja/route.ts -- la firma del token de baja es toda la seguridad
// de esta ruta, no hay cookie de sesión de la que protegerse.
const Entrada = z.object({ token: z.string().min(1, 'Falta el token.') });

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
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }

  const correo = correoDeToken(parseado.data.token);
  if (!correo) {
    return NextResponse.json({ ok: false, error: 'Este enlace no es válido.' }, { status: 400 });
  }

  const db = supabaseAdmin();
  const resultado = await registrarBaja(correo, 'pagina', db);
  if (!resultado.ok) {
    console.error('[baja] No se pudo registrar la baja desde la página.', resultado.error);
    return NextResponse.json(
      { ok: false, error: 'No pudimos procesar tu baja. Intentá de nuevo en un momento.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, correo });
}
