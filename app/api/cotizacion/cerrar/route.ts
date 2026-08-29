import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// Ronda de correcciones 1 (Tarea 8, hallazgo crítico): solo filas con
// `totales` confiables se pueden cerrar. Un `borrador` del agente se guarda
// con `lineas: []` y `totales: {}` — cerrarlo mete una fila sin monto en las
// métricas de ganado/perdido (`totales.total` es `undefined`, la suma da
// `NaN`, y al serializarse por JSON llega al panel como `null`). `/listado`
// no filtra por estado, así que un borrador aparece ahí con el botón de
// cerrar a un clic; esta guarda es la única puerta que lo evita.
//
// Ronda de correcciones 2 (decisión de producto): un vendedor que marca
// "Ganada" en la fila equivocada necesita poder corregirlo sin que alguien
// le toque la base a mano — eso no es aceptable en una herramienta de uso
// diario. Por eso el cierre se separa en dos casos, cada uno con su propio
// conjunto de estados de origen permitidos:
//
//   - Cierre inicial: desde 'creada', 'enviada' o 'error'. Fija `cerrada_at`.
//   - Corrección: desde 'ganada' o 'perdida' —la fila ya está cerrada, y
//     tiene montos confiables, así que corregirla no reabre el agujero
//     crítico—. NO toca `cerrada_at`: esa fecha es la del cierre original,
//     y pisarla con la de la corrección infla los días promedio cada vez
//     que alguien corrige un clic.
//
// 'borrador' y 'convertida' nunca están en ninguno de los dos conjuntos:
// ésa es la parte que sí importaba proteger.
const ESTADOS_CIERRE_INICIAL = ['creada', 'enviada', 'error'] as const;
const ESTADOS_CORRECCION = ['ganada', 'perdida'] as const;

const cerrarSchema = z.object({
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

  const cambiosBase: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    estado: datos.estado,
  };
  // Solo 'perdida' guarda el motivo: cerrar 'ganada' no lo pide, y no vale
  // la pena escribir `motivo_cierre: null` encima de algo que el vendedor
  // pudo haber tecleado y luego cambió de botón antes de mandar. Aplica
  // igual en un cierre inicial que en una corrección.
  if (datos.estado === 'perdida') {
    cambiosBase.motivo_cierre = datos.motivo ?? null;
  }

  // Intento 1: cierre inicial. El filtro por estado va DENTRO del `update`,
  // no en una lectura previa: así la guarda es atómica (sin ventana entre
  // "leo el estado" y "escribo"). `.select('id')` es lo que permite saber
  // si el `update` tocó alguna fila — sin esto, Supabase no avisa cuando un
  // `update` no coincide con nada, y un id inexistente (o un estado no
  // cerrable) respondía 200 "listo" sin haber cerrado nada.
  const { data: cerradaInicial, error: errorInicial } = await supabaseAdmin()
    .from('cotizaciones')
    .update({ ...cambiosBase, cerrada_at: new Date().toISOString() })
    .eq('id', datos.id)
    .in('estado', ESTADOS_CIERRE_INICIAL)
    .select('id');

  if (errorInicial) {
    console.error('[cotizador] No se pudo cerrar la cotización.', errorInicial.message);
    return NextResponse.json({ ok: false, error: 'No se pudo actualizar.' }, { status: 500 });
  }

  if (cerradaInicial && cerradaInicial.length > 0) {
    return NextResponse.json({ ok: true });
  }

  // Intento 2: corrección. No coincidió como cierre inicial — puede ser
  // porque la fila ya está 'ganada'/'perdida' (una corrección legítima) o
  // porque no existe o está en 'borrador'/'convertida' (se resuelve abajo).
  // Sin `cerrada_at` en el payload: se conserva la fecha del cierre original.
  const { data: corregida, error: errorCorreccion } = await supabaseAdmin()
    .from('cotizaciones')
    .update(cambiosBase)
    .eq('id', datos.id)
    .in('estado', ESTADOS_CORRECCION)
    .select('id');

  if (errorCorreccion) {
    console.error('[cotizador] No se pudo corregir el cierre de la cotización.', errorCorreccion.message);
    return NextResponse.json({ ok: false, error: 'No se pudo actualizar.' }, { status: 500 });
  }

  if (corregida && corregida.length > 0) {
    return NextResponse.json({ ok: true });
  }

  // Ninguno de los dos intentos coincidió: o el id no existe, o la fila
  // está en 'borrador'/'convertida' (sin totales confiables). Se pregunta
  // aparte —solo en este camino, nunca en un cierre exitoso— para
  // devolverle al vendedor un mensaje que diga qué pasó de verdad, en vez
  // de un 404 genérico cuando la fila sí existe.
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
