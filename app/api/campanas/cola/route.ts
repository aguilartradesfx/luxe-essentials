import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { estadoColaProgramada } from '@/lib/campanas/cola';

export const runtime = 'nodejs';

// Mismo motivo, exacto, que app/api/campanas/zonas/route.ts: para simular
// las zonas que todavía no tienen campaña, `estadoColaProgramada` recorre
// las trece contra GHL -- las mismas ~47 peticiones HTTP, por el mismo
// camino compartido (`contactosDeTodasLasZonas`). Sin este margen, la
// pantalla de la cola se corta a medio camino y no dibuja nada.
export const maxDuration = 60;

// La cola del envío programado (encargo: "quien abre el panel no puede ver
// la cola"): las trece zonas en su orden real, cuál está en curso, cuáles
// terminaron, cuáles esperan, cuánto falta en total y una fecha estimada
// de término. Todo derivado en el momento -- ver el comentario grande de
// lib/campanas/cola.ts sobre por qué la cola no existe como filas en la
// base.
//
// Mismo criterio de autorización que el resto de app/api/campanas/*: esta
// ruta expone a qué empresas se les va a escribir a continuación (nombre
// de zona + cuántas direcciones), así que exige superadmin releído de la
// base, no el rol de la cookie. Ver el comentario grande en
// app/api/campanas/zonas/route.ts para la decisión completa.
export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // Ruta de sólo lectura: no exige el token anti-CSRF, mismo criterio que
  // /api/campanas/zonas y /api/campanas/programado.
  const auth = await autenticarPeticion(request, crudo, { requiereCsrf: false });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = supabaseAdmin();
  const autorizacion = await autorizarSuperadmin(auth.id, db);
  if (!autorizacion.ok) {
    return NextResponse.json({ ok: false, error: 'No tenés permiso para ver la cola del envio programado.' }, { status: 403 });
  }

  const deps = {
    apiKey: process.env.LUXE_GHL_API_KEY ?? '',
    locationId: process.env.LUXE_GHL_LOCATION_ID ?? '',
  };
  if (!deps.apiKey || !deps.locationId) {
    console.error('[campanas] Faltan LUXE_GHL_API_KEY o LUXE_GHL_LOCATION_ID.');
    return NextResponse.json({ ok: false, error: 'No se pudo consultar el CRM.' }, { status: 500 });
  }

  let estado;
  try {
    estado = await estadoColaProgramada(db, deps);
  } catch (err) {
    console.error('[campanas] No se pudo calcular la cola del envio programado.', err);
    return NextResponse.json({ ok: false, error: 'No se pudo calcular la cola del envio programado.' }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    zonas: estado.zonas,
    totales: {
      direcciones: estado.totalDirecciones,
      enviadas: estado.totalEnviadas,
      fallidas: estado.totalFallidas,
      pendientes: estado.totalPendientes,
    },
    // Hallazgo de producción (2026-09-10): si alguna zona quedó en 'error'
    // (el CRM no respondió ni con reintento), los totales de arriba son un
    // PISO -- nunca el número completo. La pantalla tiene que decirlo con
    // estos dos campos, en vez de mostrar un total que finge estar
    // completo. Ver lib/campanas/cola.ts para el criterio completo.
    totalIncompleto: estado.totalIncompleto,
    zonasConError: estado.zonasConError,
    cupoHoy: estado.cupoHoy,
    fechaEstimadaFin: estado.fechaEstimadaFin,
  });
}
