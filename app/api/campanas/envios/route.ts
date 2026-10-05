import { NextResponse } from 'next/server';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { autorizarSuperadmin } from '@/lib/cotizador/equipo';
import { esEstadoEntrega } from '@/lib/campanas/estado-entrega';
import { esCursor, esUuid, listarEnvios, MAX_BUSQUEDA, type FiltrosEnvios } from '@/lib/campanas/envios-listado';

export const runtime = 'nodejs';

// Los envíos de las campañas uno por uno (pantalla «Correos enviados»):
// una página, ya filtrada, con el cursor de la siguiente. Los filtros, la
// búsqueda y el paginado se resuelven AQUÍ, en la base -- filtrar en el
// navegador sobre una página sería un filtro que miente (ver
// lib/campanas/envios-listado.ts).
//
// Esta ruta muestra la lista de clientes de la empresa: mismo criterio de
// autorización que el resto de app/api/campanas/* -- se relee la fila de
// quien pide con `autorizarSuperadmin`, nunca se confía en el rol de la
// cookie (ver app/api/campanas/zonas/route.ts). Sólo lectura: no exige el
// token anti-CSRF.
export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  const auth = await autenticarPeticion(request, crudo, { requiereCsrf: false });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = supabaseAdmin();
  const autorizacion = await autorizarSuperadmin(auth.id, db);
  if (!autorizacion.ok) {
    return NextResponse.json({ ok: false, error: 'No tenés permiso para ver los correos enviados.' }, { status: 403 });
  }

  const cuerpo = (typeof crudo === 'object' && crudo !== null ? crudo : {}) as Record<string, unknown>;
  const invalido = (campo: string) =>
    NextResponse.json({ ok: false, error: `El filtro «${campo}» no es válido.` }, { status: 400 });

  const filtros: FiltrosEnvios = {};
  if (cuerpo.zona !== undefined && cuerpo.zona !== null && cuerpo.zona !== '') {
    if (typeof cuerpo.zona !== 'string' || cuerpo.zona.length > 100) return invalido('zona');
    filtros.zona = cuerpo.zona;
  }
  if (cuerpo.campanaId !== undefined && cuerpo.campanaId !== null && cuerpo.campanaId !== '') {
    if (!esUuid(cuerpo.campanaId)) return invalido('campaña');
    filtros.campanaId = cuerpo.campanaId;
  }
  if (cuerpo.estado !== undefined && cuerpo.estado !== null && cuerpo.estado !== '') {
    if (!esEstadoEntrega(cuerpo.estado)) return invalido('estado');
    filtros.estado = cuerpo.estado;
  }
  if (cuerpo.busqueda !== undefined && cuerpo.busqueda !== null) {
    if (typeof cuerpo.busqueda !== 'string' || cuerpo.busqueda.length > MAX_BUSQUEDA * 4) return invalido('búsqueda');
    filtros.busqueda = cuerpo.busqueda;
  }
  let cursor = null;
  if (cuerpo.despues !== undefined && cuerpo.despues !== null) {
    if (!esCursor(cuerpo.despues)) return invalido('página');
    cursor = cuerpo.despues;
  }

  try {
    const pagina = await listarEnvios(db, filtros, cursor);
    return NextResponse.json({ ok: true, ...pagina });
  } catch (err) {
    console.error('[campanas] No se pudo listar los envíos.', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false, error: 'No se pudo consultar los correos enviados.' }, { status: 500 });
  }
}
