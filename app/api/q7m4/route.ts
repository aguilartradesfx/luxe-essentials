import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { generar } from '@/lib/agente/cerebro';
import { fusionarDatos, DATOS_VACIOS, type Datos } from '@/lib/agente/estado';
import type { MensajeReal } from '@/lib/agente/conversacion';

export const runtime = 'nodejs';
// Una llamada al modelo con effort bajo tarda unos segundos, pero el thinking
// adaptativo puede estirarla. Mismo criterio que el webhook del agente.
export const maxDuration = 60;

// Tope de turnos por sesión. Esto gasta cuota real de Anthropic, así que si la
// clave se filtrara, el daño queda acotado a conversaciones cortas.
const TOPE_TURNOS = 40;

function claveValida(recibida: string | null): boolean {
  const esperada = process.env.LUXE_TALLER_CLAVE;
  if (!esperada || !recibida) return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Turno = { de: 'cliente' | 'agente'; texto: string };

export async function POST(request: Request) {
  let cuerpo: { clave?: string; turnos?: Turno[]; canal?: string; datos?: Partial<Datos> };
  try {
    cuerpo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  if (!claveValida(cuerpo.clave ?? null)) {
    return NextResponse.json({ ok: false, error: 'Clave incorrecta.' }, { status: 401 });
  }

  const turnos = Array.isArray(cuerpo.turnos) ? cuerpo.turnos : [];
  if (turnos.length === 0) {
    return NextResponse.json({ ok: false, error: 'No hay ningún mensaje.' }, { status: 400 });
  }
  if (turnos.length > TOPE_TURNOS) {
    return NextResponse.json(
      { ok: false, error: `Esta sesión llegó a ${TOPE_TURNOS} turnos. Reinicia para seguir.` },
      { status: 429 },
    );
  }

  const esCorreo = cuerpo.canal === 'Email';
  const tipo = esCorreo ? ('TYPE_EMAIL' as const) : ('TYPE_WHATSAPP' as const);

  // Se reconstruye la conversación con la misma forma que trae de GoHighLevel,
  // para que el cerebro reciba exactamente lo que recibiría en producción.
  const mensajes: MensajeReal[] = turnos.map((t, i) => ({
    id: `taller-${i}`,
    tipo,
    direccion: t.de === 'cliente' ? 'inbound' : 'outbound',
    texto: t.texto,
    adjuntos: [],
  }));

  // Todos los salientes de esta conversación los escribió el agente, así que
  // ninguno debe marcarse como "de un asesor humano".
  const mios = mensajes.filter((m) => m.direccion === 'outbound').map((m) => m.id);

  const datosPrevios = { ...DATOS_VACIOS, ...(cuerpo.datos ?? {}) } as Datos;

  const generado = await generar(
    {
      mensajes,
      mios,
      transcripciones: [],
      bloques: [],
      datosPrevios,
      huboFallosDeMedios: false,
      esCorreo,
    },
    { anthropicKey: process.env.LUXE_ANTHROPIC_API_KEY ?? '' },
  );

  if (!generado.ok) {
    return NextResponse.json({ ok: false, error: generado.error }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    respuesta: generado.salida.respuesta,
    datos: fusionarDatos(datosPrevios, generado.salida.datos),
  });
}
