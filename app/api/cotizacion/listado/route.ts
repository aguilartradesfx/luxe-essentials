import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const MAX_LIMITE = 200;

const listadoSchema = z.object({
  estado: z.string().optional(),
  limite: z.number().int('El límite debe ser un número entero.').positive('El límite debe ser mayor que cero.').optional(),
});

// Columnas del listado: deliberadamente SIN `lineas`. La pantalla muestra
// cliente, monto, fecha y estado — no necesita el detalle de cada producto
// de cada fila, y son muchos datos para traer en cada carga. `contact_id` sí
// viaja: la pantalla lo usa para enlazar a la ficha del contacto en
// GoHighLevel.
// `vendedor` viaja tal cual quedó guardado en la fila (columna `vendedor`,
// Tarea 1): nombre libre, no una llave foránea a un usuario — las filas
// anteriores a esta fase lo traen en null y así se muestran, sin inventar
// un nombre (ver VistaListado.tsx).
// `reemplaza_a_numero`/`reemplazada_por_numero` (migración 0016): el rastro
// de "Modificar" entre dos filas -- en la nueva, a cuál reemplaza; en la
// vieja, cuál la reemplazó. Se manda el numero denormalizado, no el id: es
// lo que el vendedor reconoce (lo que el cliente cita por teléfono), y así
// esta pantalla no necesita un join ni una segunda consulta para mostrarlo.
//
// Fase 5 (descuento con aprobación, migración 0017): las seis columnas
// nuevas de `cotizaciones`. Esta pantalla es la que la pantalla general
// (todos los estados, no sólo las pendientes -- para eso está
// /api/cotizacion/pendientes) necesita para mostrar el estado
// 'esperando_aprobacion'/'rechazada', quién lo pidió y, restando
// `created_at` a ahora, cuánto lleva esperando (diseño, sección de
// riesgos: "el listado muestra cuánto lleva esperando"). `descuento_aprobado`
// viaja también: es lo único que distingue, en una fila ya resuelta, si el
// superadmin aprobó tal cual o cambió el porcentaje.
const COLUMNAS =
  'id, numero, created_at, updated_at, estado, origen, contact_id, cliente, totales, ' +
  'enviado_at, cerrada_at, pdf_ruta, motivo_cierre, ghl_estimate_id, ghl_error, correo_error, vendedor, ' +
  'reemplaza_a_numero, reemplazada_por_numero, ' +
  'descuento_personalizado, solicitado_por, aprobado_por, resuelto_at, motivo_rechazo, descuento_aprobado';

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // La credencial se revisa antes que el esquema: mismo motivo que en el
  // resto de app/api/cotizacion/* — no filtrar la forma del cuerpo a quien
  // no tiene credencial. Ruta de solo lectura (SELECT): no exige el token
  // anti-CSRF, ese requisito es de las que escriben (/cerrar, /reenviar).
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: false });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const parseado = listadoSchema.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }
  const datos = parseado.data;
  const limite = Math.min(datos.limite ?? MAX_LIMITE, MAX_LIMITE);

  let consulta = supabaseAdmin().from('cotizaciones').select(COLUMNAS);
  if (datos.estado) {
    consulta = consulta.eq('estado', datos.estado);
  }

  const { data, error } = await consulta.order('created_at', { ascending: false }).limit(limite);

  if (error) {
    console.error('[cotizador] No se pudo consultar el listado de cotizaciones.', error.message);
    return NextResponse.json({ ok: false, error: 'No se pudo consultar.' }, { status: 500 });
  }

  // Tarea 10: la pantalla arma el enlace a la ficha del contacto en
  // GoHighLevel (`.../location/<locationId>/contacts/detail/<contactId>`).
  // El `locationId` viaja desde acá — nunca desde una variable pública ni
  // desde el catálogo — porque es la única fuente que el navegador tiene
  // permitido leer sin que un env var termine expuesto en el bundle de
  // cliente. Mismo env var que ya usan las rutas que hablan con GoHighLevel
  // (app/api/cotizacion/route.ts, app/api/ghl/webhook/route.ts).
  return NextResponse.json({
    ok: true,
    cotizaciones: data ?? [],
    locationId: process.env.LUXE_GHL_LOCATION_ID ?? '',
  });
}
