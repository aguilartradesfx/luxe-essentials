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
  id: z.string().min(1, 'Falta el id de la cotización.'),
});

type FilaReenviar = {
  id: string;
  numero: string;
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

  const { data: fila, error: errorConsulta } = await db
    .from('cotizaciones')
    .select('id, numero, cliente, totales, created_at, pdf_ruta')
    .eq('id', datos.id)
    .single();

  if (errorConsulta || !fila) {
    console.error(
      '[cotizador] No se encontró la cotización a reenviar.',
      errorConsulta?.message ?? 'sin fila',
    );
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

  const vence = new Date(filaTipada.created_at);
  vence.setDate(vence.getDate() + DIAS_VIGENCIA);

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
    console.error('[cotizador] No se pudo reenviar el correo.', correoResultado.error);
    return NextResponse.json({ ok: false, error: 'No se pudo reenviar el correo.' }, { status: 502 });
  }

  const { error: errorActualizacion } = await db
    .from('cotizaciones')
    .update({
      updated_at: new Date().toISOString(),
      enviado_at: new Date().toISOString(),
      resend_id: correoResultado.resendId,
    })
    .eq('id', datos.id);

  if (errorActualizacion) {
    // El correo ya salió: esto no invalida ese envío, pero si falla en
    // silencio la fila no refleja el reenvío. Se registra para que sea
    // recuperable a mano, sin tumbar la respuesta.
    console.error(
      '[cotizador] El reenvío se procesó pero no se pudo actualizar la fila.',
      errorActualizacion.message,
    );
  }

  return NextResponse.json({ ok: true, resendId: correoResultado.resendId });
}
