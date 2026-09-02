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
    // El juicio de si lo que llegó fue una respuesta automática del sistema
    // del OTRO lado (un saludo de bienvenida que salta solo, un aviso de
    // fuera de horario, "en breve le atenderemos") lo hace el modelo, no una
    // lista de palabras: los mensajes automáticos son demasiado variados para
    // eso. Ver la instrucción completa, con ejemplos de los dos lados, en
    // PROMPT_SISTEMA. `procesar.ts` es quien actúa sobre este campo: si viene
    // en true, no manda "respuesta", no cuenta el turno y no toca la ficha
    // del contacto.
    esAutomatico: { type: 'boolean' },
    datos: {
      type: 'object',
      properties: {
        nombre: { type: ['string', 'null'] },
        email: { type: ['string', 'null'] },
        telefono: { type: ['string', 'null'] },
        // `producto` usa anyOf y sus hermanos no, y la diferencia es deliberada:
        // la API acepta `type: ['string','null']` mientras no haya enum, pero lo
        // rechaza con 400 en cuanto se combina con uno ("Enum value 'uniformes'
        // does not match declared type"). Verificado contra la API real el
        // 2026-08-24; no lo "uniformes" con sus hermanos sin volver a probarlo,
        // porque ninguna prueba de este repo puede detectarlo: todas simulan
        // fetch, así que el fallo sólo aparecería en producción y en cada
        // mensaje.
        producto: {
          anyOf: [{ type: 'string', enum: [...PRODUCTOS] }, { type: 'null' }],
        },
        ubicacion: { type: ['string', 'null'] },
        cantidad: { type: ['string', 'null'] },
      },
      required: ['nombre', 'email', 'telefono', 'producto', 'ubicacion', 'cantidad'],
      additionalProperties: false,
    },
  },
  required: ['respuesta', 'esAutomatico', 'datos'],
  additionalProperties: false,
} as const;

// El mismo contrato, validado de nuestro lado. La API garantiza la forma, pero
// no confiamos en ella para algo que se le envía a un cliente real.
const salidaSchema = z.object({
  respuesta: z.string().trim().min(1).max(1500),
  esAutomatico: z.boolean(),
  datos: z.object({
    nombre: z.string().nullable(),
    email: z.string().nullable(),
    telefono: z.string().nullable(),
    producto: z.enum(PRODUCTOS).nullable(),
    ubicacion: z.string().nullable(),
    cantidad: z.string().nullable(),
  }),
});

export type Salida = z.infer<typeof salidaSchema>;

// Consumo real del turno. Se expone para que quien llame pueda medir el coste
// sin volver a estimarlo a ojo: el banco de pruebas lo muestra en vivo, y el
// orquestador puede registrarlo si algún día hace falta.
export type Uso = {
  entrada: number;
  salida: number;
  cacheEscrito: number;
  cacheLeido: number;
};

// Lo que la ficha del contacto ya traía en GoHighLevel antes de esta
// conversación (ver `leerContacto` en acciones.ts). Va aparte de
// `datosPrevios`: eso es lo que el CLIENTE fue diciendo turno a turno, esto es
// lo que el CRM ya sabía sin que nadie lo escribiera aquí. El prompt le pide
// al modelo confirmarlo en vez de preguntarlo — pero sólo si de verdad parece
// el nombre de una persona.
export type FichaCRM = {
  nombre: string | null;
  email: string | null;
  telefono: string | null;
};

export type EntradaCerebro = {
  mensajes: MensajeReal[];
  mios: string[];
  transcripciones: string[];
  bloques: BloqueImagen[];
  datosPrevios: Datos;
  fichaCRM: FichaCRM;
  huboFallosDeMedios: boolean;
  esCorreo: boolean;
};

type Deps = { anthropicKey: string; fetchImpl?: typeof fetch };
type Resultado = { ok: true; salida: Salida; uso: Uso } | { ok: false; error: string };

type Bloque = BloqueImagen | { type: 'text'; text: string };

function construirMensajes(e: EntradaCerebro) {
  const mios = new Set(e.mios);
  const turnos = e.mensajes.map((m) => ({
    role: m.direccion === 'inbound' ? ('user' as const) : ('assistant' as const),
    content: [
      {
        type: 'text' as const,
        // Un saliente que no mandamos nosotros lo escribió un asesor. Sin
        // marcarlo, el modelo lo lee como propio y puede reafirmar precios o
        // plazos que un humano dio hace meses — justo lo que el prompt prohíbe.
        text:
          m.direccion === 'outbound' && !mios.has(m.id)
            ? `[mensaje escrito por un asesor humano] ${m.texto || '(sin texto)'}`
            : m.texto || '(sin texto)',
      },
    ] as Bloque[],
  }));

  // La API exige que el primer turno sea del usuario.
  //
  // Los turnos consecutivos del MISMO rol sí se aceptan: la API los combina.
  // Verificado contra la API real el 2026-08-24 con tres turnos `user` seguidos
  // y con user/assistant/user/user, ambos 200 y extrayendo bien los datos. No
  // hace falta fusionarlos, y es un caso normal en WhatsApp, donde la gente
  // manda tres mensajes cortos en vez de uno largo.
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

  // La ficha del CRM va como un bloque APARTE del que sigue (lo que el
  // cliente fue diciendo en la conversación): el prompt le pide al modelo
  // distinguir uno de otro, porque a lo que trae la ficha se lo confirma, no
  // se lo pregunta desde cero — y sólo si de verdad parece el nombre de una
  // persona, no un apodo o el nombre de un negocio.
  const yaTraiaLaFicha = Object.entries(e.fichaCRM)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  ultimo.content.push({
    type: 'text',
    text: yaTraiaLaFicha
      ? `[esto ya estaba en la ficha del contacto en el CRM, antes de que esta persona escribiera nada en esta conversación: ${yaTraiaLaFicha}]`
      : '[la ficha del contacto en el CRM no traía nombre, correo ni teléfono]',
  });

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
    // Tope duro sobre thinking MÁS texto de respuesta. Con `effort: 'low'` el
    // thinking es breve, pero 1024 dejaba un margen que una respuesta larga se
    // come: al truncar, `content` trae JSON parcial, el parseo falla y el
    // mensaje del cliente queda consumido sin respuesta.
    max_tokens: 4096,
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

    let datos: {
      stop_reason?: string;
      content?: { type?: string; text?: string }[];
      usage?: Record<string, number>;
    };
    try {
      datos = JSON.parse(texto);
    } catch {
      return { ok: false, error: 'Anthropic devolvió una respuesta que no es JSON.' };
    }

    // Un refusal llega con HTTP 200 y content vacío. Hay que mirarlo ANTES de
    // tocar content[0], o el fallo aparece como un TypeError sin relación.
    if (datos.stop_reason === 'refusal') {
      return { ok: false, error: 'Anthropic devolvió stop_reason: refusal' };
    }

    // El truncamiento no es un error HTTP: llega 200 con JSON a medias. Sin esta
    // comprobación el fallo aparece como "no devolvió JSON válido", que no
    // distingue quedarnos cortos de presupuesto de un modelo que se portó mal.
    if (datos.stop_reason === 'max_tokens') {
      return { ok: false, error: 'Anthropic truncó la salida por max_tokens.' };
    }

    const bruto = datos.content?.find((b) => b.type === 'text')?.text;
    if (!bruto) return { ok: false, error: 'Anthropic no devolvió ningún bloque de texto.' };

    // El mensaje del SyntaxError de JSON.parse incluye un fragmento de la
    // entrada —para cadenas cortas, la entrada entera—, y `bruto` es texto que
    // el modelo generó a partir de lo que escribió el cliente. Ese error acaba
    // en el log del servidor, así que se sustituye por uno fijo: el repo no
    // registra contenido de clientes en ninguna parte.
    let crudo: unknown;
    try {
      crudo = JSON.parse(bruto);
    } catch {
      return { ok: false, error: 'Anthropic no devolvió JSON válido.' };
    }

    const parseado = salidaSchema.safeParse(crudo);
    if (!parseado.success) {
      return { ok: false, error: `La salida no cumple el esquema: ${parseado.error.issues[0]?.message}` };
    }

    const u = datos.usage ?? {};
    return {
      ok: true,
      salida: parseado.data,
      uso: {
        entrada: u.input_tokens ?? 0,
        salida: u.output_tokens ?? 0,
        cacheEscrito: u.cache_creation_input_tokens ?? 0,
        cacheLeido: u.cache_read_input_tokens ?? 0,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
