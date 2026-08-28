import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// Ronda de correcciones 1 (Tarea 8, hallazgo crítico): solo estas tres son
// filas de verdad, con `totales` confiables (mismo criterio que
// `ESTADOS_REALES` en lib/cotizador/metricas.ts, pero acá se llama distinto
// porque el conjunto no es idéntico — 'ganada'/'perdida' quedan afuera
// porque cerrar una fila YA cerrada es el otro bug de esta ronda, ver más
// abajo). Sin esta guarda, cerrar un `borrador` del agente (que se guarda
// con `lineas: []` y `totales: {}`) mete una fila sin monto en las métricas
// de ganado/perdido: `totales.total` es `undefined`, la suma da `NaN`, y al
// serializarse por JSON llega al panel como `null` — se caen tres números a
// la vez. `/listado` no filtra por estado, así que un borrador aparece ahí
// con el botón de cerrar a un clic; esta es la única puerta que lo evita.
const ESTADOS_CERRABLES = ['creada', 'enviada', 'error'] as const;

const cerrarSchema = z.object({
  clave: z.string().optional(),
  // Ronda de correcciones 1: un id que no es UUID revienta en Postgres (el
  // driver rechaza el literal) y eso subía como 500 en vez de 400 — un error
  // de quien llama, no de la base.
  id: z.uuid('El id de la cotización no es válido.'),
  // Único par de estados que un vendedor puede poner a mano desde el panel:
  // cualquier otro valor —incluidos los que el propio sistema asigna solo,
  // como 'enviada' o 'error'— se rechaza acá.
  estado: z.enum(['ganada', 'perdida'], { message: 'El estado debe ser "ganada" o "perdida".' }),
  motivo: z.string().trim().max(500, 'Resume un poco el motivo.').optional(),
});

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // La credencial se revisa antes que el esquema: mismo motivo que en el
  // resto de app/api/cotizacion/*. Esta ruta escribe (cierra la cotización):
  // `requiereCsrf: true` exige el token anti-CSRF cuando se entra por
  // cookie (ver lib/autenticacion-cotizador.ts) — con `SameSite=None` esa
  // cookie viaja sola en peticiones que origina cualquier otro sitio que el
  // vendedor visite, y el token es la única defensa contra eso.
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const parseado = cerrarSchema.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }
  const datos = parseado.data;

  const cambios: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    estado: datos.estado,
    cerrada_at: new Date().toISOString(),
  };
  // Solo 'perdida' guarda el motivo: cerrar 'ganada' no lo pide, y no vale
  // la pena escribir `motivo_cierre: null` encima de algo que el vendedor
  // pudo haber tecleado y luego cambió de botón antes de mandar.
  if (datos.estado === 'perdida') {
    cambios.motivo_cierre = datos.motivo ?? null;
  }

  // El filtro por estado va DENTRO del `update`, no en una lectura previa:
  // así la guarda es atómica (sin ventana entre "leo el estado" y "escribo")
  // y de paso resuelve el otro bug de esta ronda —recerrar una cotización ya
  // 'ganada'/'perdida' pisaba `cerrada_at` con la fecha del reclic, inflando
  // los días promedio de cierre cada vez—: como esos dos estados no están en
  // `ESTADOS_CERRABLES`, un segundo cierre ya no encuentra fila que
  // actualizar y cae en la rama de abajo. `.select('id')` es lo que permite
  // distinguir "sí actualizó algo" de "no coincidió con nada" — sin esto,
  // Supabase no avisa cuando un `update` no toca ninguna fila, y un id
  // inexistente respondía 200 "listo" sin haber cerrado nada.
  const { data: actualizadas, error } = await supabaseAdmin()
    .from('cotizaciones')
    .update(cambios)
    .eq('id', datos.id)
    .in('estado', ESTADOS_CERRABLES)
    .select('id');

  if (error) {
    console.error('[cotizador] No se pudo cerrar la cotización.', error.message);
    return NextResponse.json({ ok: false, error: 'No se pudo actualizar.' }, { status: 500 });
  }

  if (!actualizadas || actualizadas.length === 0) {
    // No coincidió: o el id no existe, o la fila no está en un estado
    // cerrable (ya cerrada, o un borrador/convertida sin totales
    // confiables). Postgres no distingue los dos casos en el resultado del
    // `update`, así que se pregunta aparte —solo en este camino, nunca en
    // un cierre exitoso— para devolverle al vendedor un mensaje que diga
    // qué pasó de verdad, en vez de un 404 genérico cuando la fila sí existe.
    const { data: filaActual } = await supabaseAdmin()
      .from('cotizaciones')
      .select('estado')
      .eq('id', datos.id)
      .maybeSingle();

    if (!filaActual) {
      return NextResponse.json({ ok: false, error: 'Cotización no encontrada.' }, { status: 404 });
    }
    return NextResponse.json(
      { ok: false, error: `No se puede cerrar una cotización en estado "${filaActual.estado}".` },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true });
}
