import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { ZONAS_COMERCIALES, contactosDeTodasLasZonas, conCorreo } from '@/lib/campanas/contactos';

export const runtime = 'nodejs';

// Menor m4 (revisión final): lanza trece paginaciones en paralelo contra
// GoHighLevel -- unas 47 peticiones HTTP cada vez que alguien abre la
// pantalla de campañas. Sin `maxDuration` se corta con el límite por
// defecto y la pantalla no dibuja NINGUNA zona, con lo que la bandeja
// entera parece rota. Mismo valor y mismo criterio que el resto de las
// rutas pesadas del proyecto.
export const maxDuration = 60;

// Bandeja de campañas (parte 2): las trece pestañas de zona, con su
// conteo. Toda `app/api/campanas/*` -- ésta incluida -- exige superadmin de
// verdad, releído de la base con `autorizarSuperadmin`, con el MISMO
// criterio que ya usan `app/api/equipo/*` y las rutas de aprobación.
//
// LA DECISIÓN, explicada acá una vez porque las siete rutas de campañas la
// comparten: un vendedor puede armar y enviar una COTIZACIÓN sin
// supervisión (Fase 1-4), pero una campaña no es una cotización -- una
// cotización se manda a UN cliente, con UN número que se puede anular; una
// campaña se manda de golpe a cientos o miles de contactos, en nombre de
// Luxe, desde un dominio de correo que recién se está construyendo
// reputación (docs/superpowers/specs/2026-09-08-campanas-design.md, sección
// de riesgos). El costo de un error -- un vendedor que aprieta "enviar" dos
// veces, que elige la plantilla equivocada, que manda a la zona entera en
// vez de a la página que tenía filtrada -- no se puede deshacer con un
// clic, como sí se puede anular una cotización. Por eso TODA esta
// superficie (ver, no sólo enviar) queda detrás de superadmin: el mismo
// grupo chico y de confianza que ya administra el equipo y aprueba
// descuentos fuera de escala. Es una decisión conservadora a propósito --
// prioriza que nadie mande 2.700 correos por error sobre la comodidad de
// que cualquier vendedor pueda usar esta pantalla.
export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // Ruta de solo lectura: no exige el token anti-CSRF, igual que
  // /api/equipo/listar y /api/cotizacion/pendientes.
  const auth = await autenticarPeticion(request, crudo, { requiereCsrf: false });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = supabaseAdmin();
  const autorizacion = await autorizarSuperadmin(auth.id, db);
  if (!autorizacion.ok) {
    return NextResponse.json({ ok: false, error: 'No tenés permiso para ver campañas.' }, { status: 403 });
  }

  const deps = {
    apiKey: process.env.LUXE_GHL_API_KEY ?? '',
    locationId: process.env.LUXE_GHL_LOCATION_ID ?? '',
  };
  if (!deps.apiKey || !deps.locationId) {
    console.error('[campanas] Faltan LUXE_GHL_API_KEY o LUXE_GHL_LOCATION_ID.');
    return NextResponse.json({ ok: false, error: 'No se pudo consultar el CRM.' }, { status: 500 });
  }

  // Las trece zonas, en paralelo -- son llamadas de sólo lectura,
  // independientes entre sí, y ninguna depende del resultado de otra. Un
  // fallo de UNA zona (GHL caído a mitad de camino, un timeout puntual) no
  // tira abajo el resto: esa zona vuelve con `error` y conteo en cero, en
  // vez de que las trece pestañas se queden sin dibujar por un problema de
  // una sola. `contactosDeTodasLasZonas` (lib/campanas/contactos.ts) es el
  // mismo camino que usa la cola del envío programado
  // (app/api/campanas/cola/route.ts) -- un solo lugar que lanza las ~47
  // peticiones a GHL, no dos copias que puedan divergir.
  const todas = await contactosDeTodasLasZonas(deps);
  const resultados = ZONAS_COMERCIALES.map((zona) => {
    const resultado = todas[zona];
    if (!resultado.ok) {
      console.error('[campanas] No se pudo traer la zona', zona, resultado.error);
      return { zona, total: 0, conCorreo: 0, error: resultado.error };
    }
    return { zona, total: resultado.contactos.length, conCorreo: conCorreo(resultado.contactos).length };
  });

  return NextResponse.json({ ok: true, zonas: resultados });
}
