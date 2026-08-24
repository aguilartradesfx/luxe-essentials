import { z } from 'zod';
import { config, PRODUCTOS } from '@/lib/agente/config';
import type { Datos } from '@/lib/agente/estado';
import type { BloqueImagen } from '@/lib/agente/medios';
import type { MensajeReal } from '@/lib/agente/conversacion';

// El esquema que se le impone a la API. `additionalProperties: false` y todas
// las claves en `required` son obligatorios para la salida estructurada.
const ESQUEMA = {
  type: 'object',
  properties: {
    respuesta: { type: 'string' },
    datos: {
      type: 'object',
      properties: {
        nombre: { type: ['string', 'null'] },
        email: { type: ['string', 'null'] },
        telefono: { type: ['string', 'null'] },
        producto: { type: ['string', 'null'], enum: [...PRODUCTOS, null] },
        ubicacion: { type: ['string', 'null'] },
      },
      required: ['nombre', 'email', 'telefono', 'producto', 'ubicacion'],
      additionalProperties: false,
    },
  },
  required: ['respuesta', 'datos'],
  additionalProperties: false,
} as const;

// El mismo contrato, validado de nuestro lado. La API garantiza la forma, pero
// no confiamos en ella para algo que se le envía a un cliente real.
const salidaSchema = z.object({
  respuesta: z.string().trim().min(1).max(1500),
  datos: z.object({
    nombre: z.string().nullable(),
    email: z.string().nullable(),
    telefono: z.string().nullable(),
    producto: z.enum(PRODUCTOS).nullable(),
    ubicacion: z.string().nullable(),
  }),
});

export type Salida = z.infer<typeof salidaSchema>;

export type EntradaCerebro = {
  mensajes: MensajeReal[];
  transcripciones: string[];
  bloques: BloqueImagen[];
  datosPrevios: Datos;
  huboFallosDeMedios: boolean;
  esCorreo: boolean;
};

type Deps = { anthropicKey: string; fetchImpl?: typeof fetch };
type Resultado = { ok: true; salida: Salida } | { ok: false; error: string };

type Bloque = BloqueImagen | { type: 'text'; text: string };

function construirMensajes(e: EntradaCerebro) {
  const turnos = e.mensajes.map((m) => ({
    role: m.direccion === 'inbound' ? ('user' as const) : ('assistant' as const),
    content: [{ type: 'text' as const, text: m.texto || '(sin texto)' }] as Bloque[],
  }));

  // La API exige que el primer turno sea del usuario.
  while (turnos.length > 0 && turnos[0].role === 'assistant') turnos.shift();
  if (turnos.length === 0) {
    turnos.push({ role: 'user', content: [{ type: 'text', text: '(sin texto)' }] });
  }

  const ultimo = turnos[turnos.length - 1];
  for (const t of e.transcripciones) {
    ultimo.content.push({ type: 'text', text: `[nota de voz transcrita] ${t}` });
  }
  ultimo.content.push(...e.bloques);
  if (e.huboFallosDeMedios) {
    ultimo.content.push({
      type: 'text',
      text: '[el cliente envió un adjunto que no se pudo leer; pídele amablemente que lo repita por escrito]',
    });
  }

  // Los datos ya capturados van como contexto para que no los vuelva a pedir.
  const yaSe = Object.entries(e.datosPrevios)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  ultimo.content.push({
    type: 'text',
    text: yaSe
      ? `[datos que ya tienes de esta persona: ${yaSe}]`
      : '[aún no tienes ningún dato de esta persona]',
  });

  if (e.esCorreo) {
    ultimo.content.push({
      type: 'text',
      text: '[este es un correo y sólo se le responderá una vez: pide todos los datos que falten en este único mensaje]',
    });
  }

  return turnos;
}

export async function generar(entrada: EntradaCerebro, deps: Deps): Promise<Resultado> {
  const { anthropicKey, fetchImpl = fetch } = deps;

  const cuerpo = {
    model: 'claude-opus-5',
    max_tokens: 1024,
    // El thinking NO se manda: en Opus 5 está adaptativo por defecto, y
    // apagarlo hace que la salida estructurada salga a veces como texto plano,
    // con el turno terminando en éxito aparente y sin JSON.
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: ESQUEMA },
    },
    system: [
      { type: 'text', text: config.PROMPT_SISTEMA, cache_control: { type: 'ephemeral' } },
    ],
    messages: construirMensajes(entrada),
  };

  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(cuerpo),
    });

    const texto = await res.text();
    if (!res.ok) return { ok: false, error: `Anthropic ${res.status}: ${texto.slice(0, 200)}` };

    const datos = JSON.parse(texto) as {
      stop_reason?: string;
      content?: { type?: string; text?: string }[];
    };

    // Un refusal llega con HTTP 200 y content vacío. Hay que mirarlo ANTES de
    // tocar content[0], o el fallo aparece como un TypeError sin relación.
    if (datos.stop_reason === 'refusal') {
      return { ok: false, error: 'Anthropic devolvió stop_reason: refusal' };
    }

    const bruto = datos.content?.find((b) => b.type === 'text')?.text;
    if (!bruto) return { ok: false, error: 'Anthropic no devolvió ningún bloque de texto.' };

    const parseado = salidaSchema.safeParse(JSON.parse(bruto));
    if (!parseado.success) {
      return { ok: false, error: `La salida no cumple el esquema: ${parseado.error.issues[0]?.message}` };
    }

    return { ok: true, salida: parseado.data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
