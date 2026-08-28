import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autenticarPeticion } from '@/lib/autenticacion-cotizador';
import { supabaseAdmin } from '@/lib/supabase/server';
import { enlaceFirmado, BUCKET } from '@/lib/cotizador/almacen';
import { enviarCotizacion } from '@/lib/cotizador/correo';

export const runtime = 'nodejs';

// Mismo valor que `DIAS_VIGENCIA` en app/api/cotizacion/route.ts (no
// exportado de ahí, se duplica acá por la misma razón que las notas de
// documento.tsx/correo.ts): la vigencia se cuenta desde que la cotización se
// creó, no se extiende por reenviarla.
const DIAS_VIGENCIA = 30;

const reenviarSchema = z.object({
  clave: z.string().optional(),
  // Ronda de correcciones 1: un id que no es UUID revienta en Postgres como
  // 500 en vez de 400 — mismo motivo que en /cerrar.
  id: z.uuid('El id de la cotización no es válido.'),
});

type FilaReenviar = {
  id: string;
  numero: string;
  estado: string;
  cliente: { nombre: string; empresa?: string; email: string };
  totales: { total: number };
  created_at: string;
  pdf_ruta: string | null;
};

export async function POST(request: Request) {
  let crudo: unknown;
  try {
    crudo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  // La credencial se revisa antes que el esquema: mismo motivo que en el
  // resto de app/api/cotizacion/*. Esta ruta escribe (reenvía el correo y
  // actualiza la fila): exige el token anti-CSRF cuando se entra por cookie.
  const auth = autenticarPeticion(request, crudo, { requiereCsrf: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const parseado = reenviarSchema.safeParse(crudo);
  if (!parseado.success) {
    return NextResponse.json(
      { ok: false, error: parseado.error.issues[0]?.message ?? 'Datos inválidos.' },
      { status: 400 },
    );
  }
  const datos = parseado.data;

  const db = supabaseAdmin();

  // Ronda de correcciones 2 (hallazgo importante): antes esto usaba
  // `.single()`, que Postgres/PostgREST responde con un `error` tanto para
  // "no hay ninguna fila" como para una caída real de la base — las dos
  // ramas caían en el mismo `if` de abajo y una caída de la base le
  // aparecía al vendedor como "cotización no encontrada". `.maybeSingle()`
  // separa los dos casos: sin filas, `error` es `null` y `data` es `null`;
  // con una falla real, `error` viene poblado.
  const { data: fila, error: errorConsulta } = await db
    .from('cotizaciones')
    .select('id, numero, estado, cliente, totales, created_at, pdf_ruta')
    .eq('id', datos.id)
    .maybeSingle();

  if (errorConsulta) {
    console.error('[cotizador] No se pudo consultar la cotización a reenviar.', errorConsulta.message);
    return NextResponse.json({ ok: false, error: 'No se pudo consultar.' }, { status: 500 });
  }

  if (!fila) {
    return NextResponse.json({ ok: false, error: 'Cotización no encontrada.' }, { status: 404 });
  }

  const filaTipada = fila as FilaReenviar;

  // Sin PDF guardado no hay nada que adjuntar al correo: un error claro acá
  // vale más que uno confuso más adelante al intentar descargar una ruta
  // que no existe.
  if (!filaTipada.pdf_ruta) {
    return NextResponse.json(
      { ok: false, error: 'Esta cotización no tiene un PDF guardado: no hay nada que reenviar.' },
      { status: 400 },
    );
  }

  const { data: pdfBlob, error: errorDescarga } = await db.storage.from(BUCKET).download(filaTipada.pdf_ruta);
  if (errorDescarga || !pdfBlob) {
    console.error(
      '[cotizador] No se pudo descargar el PDF guardado para reenviarlo.',
      errorDescarga?.message ?? 'sin datos',
    );
    return NextResponse.json({ ok: false, error: 'No se pudo leer el PDF guardado.' }, { status: 500 });
  }
  const pdfBuffer = Buffer.from(await pdfBlob.arrayBuffer());

  // No lanza (lib/cotizador/almacen.ts): si falla, se registra y el correo
  // sigue sin enlace, igual que en app/api/cotizacion/route.ts.
  const firmado = await enlaceFirmado(filaTipada.pdf_ruta, db);
  if (!firmado.ok) {
    console.error('[cotizador] No se pudo firmar el enlace del PDF al reenviar.', firmado.error);
  }

  // Fija desde `created_at`, nunca desde "ahora": es la misma fecha que ya
  // llevaba el PDF que se está reenviando (el archivo no cambia, solo se
  // vuelve a mandar), y es la que después usa esta misma respuesta para el
  // aviso de `vencida`.
  const vence = new Date(filaTipada.created_at);
  vence.setDate(vence.getDate() + DIAS_VIGENCIA);
  const vencida = vence.getTime() < Date.now();

  const correoResultado = await enviarCotizacion(
    {
      numero: filaTipada.numero,
      cliente: filaTipada.cliente,
      total: filaTipada.totales.total,
      vence,
      pdf: pdfBuffer,
      enlace: firmado.ok ? firmado.url : '',
    },
    {
      apiKey: process.env.RESEND_API_KEY ?? '',
      remitente: process.env.LUXE_CORREO_REMITENTE ?? '',
    },
  );

  if (!correoResultado.ok) {
    // A diferencia de app/api/cotizacion/route.ts (que hace varias cosas y
    // no es idempotente: si el correo falla ahí, la cotización igual quedó
    // creada con su número y su PDF, y un 5xx invitaría a un reintento que
    // duplica la cotización), /reenviar hace una sola cosa. Si falla, no
    // pasó nada — reintentar es seguro. Por eso sí es un error HTTP: 502,
    // más preciso que un 500 genérico porque quien falló fue Resend, no
    // la base.
    console.error('[cotizador] No se pudo reenviar el correo.', correoResultado.error);
    return NextResponse.json({ ok: false, error: 'No se pudo reenviar el correo.' }, { status: 502 });
  }

  // Ronda de correcciones 2 (hallazgo importante): antes `estado` pasaba a
  // 'enviada' sin condición — eso sanaba el caso que importaba (una fila en
  // 'error' por un primer envío fallido) pero también reabría una
  // cotización ya 'ganada'/'perdida' con solo reenviarla. Ahora solo sana
  // cuando venía de 'error'; si ya estaba 'enviada' se deja como está (sin
  // escritura de más), y si está cerrada no se toca en absoluto.
  const cambios: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    resend_id: correoResultado.resendId,
  };
  if (filaTipada.estado === 'error') {
    cambios.estado = 'enviada';
  }

  const { error: errorActualizacion } = await db.from('cotizaciones').update(cambios).eq('id', datos.id);

  if (errorActualizacion) {
    // Ronda de correcciones 2 (hallazgo importante): antes esto se
    // registraba en el log y la respuesta decía `ok: true` igual, sin
    // avisar que el registro se quedó desactualizado. El correo ya salió
    // —eso no se revierte, y no vale la pena tumbar la respuesta por
    // esto— pero el vendedor tiene que enterarse de que el estado que ve en
    // el panel puede no reflejar este reenvío todavía.
    console.error(
      '[cotizador] El reenvío se procesó pero no se pudo actualizar la fila.',
      errorActualizacion.message,
    );
    return NextResponse.json({
      ok: true,
      resendId: correoResultado.resendId,
      vencida,
      actualizado: false,
      avisoActualizacion: 'El correo se reenvió, pero no se pudo actualizar el registro. Actualizá la página para ver el estado real.',
    });
  }

  // `vencida`: para que la pantalla le diga al vendedor que el precio que
  // se acaba de reenviar ya no corre, y que conviene duplicar la cotización
  // y cotizar de nuevo en vez de reenviar un PDF con una fecha vencida.
  return NextResponse.json({ ok: true, resendId: correoResultado.resendId, vencida, actualizado: true });
}
