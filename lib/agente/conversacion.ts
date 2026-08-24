import { config } from '@/lib/agente/config';
import { esMensajeReal, type TipoReal } from '@/lib/agente/canal';

export type MensajeReal = {
  id: string;
  tipo: TipoReal;
  direccion: 'inbound' | 'outbound';
  texto: string;
  adjuntos: string[];
};

export type Conversacion = {
  conversationId: string;
  // Orden cronológico ascendente: el más reciente al final.
  mensajes: MensajeReal[];
};

export type DepsGhl = {
  apiKey: string;
  locationId: string;
  fetchImpl?: typeof fetch;
};

type Resultado =
  | { ok: true; conversacion: Conversacion }
  | { ok: false; error: string };

function cabeceras(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: config.VERSION_CONVERSACIONES,
    Accept: 'application/json',
  };
}

// GHL devuelve los mensajes bajo `messages.messages` en unas respuestas y bajo
// `messages` en otras. Igual que `upsertContact` acepta las dos formas del
// contacto, aceptamos las dos formas aquí.
function extraerCrudos(datos: unknown): unknown[] {
  const d = datos as { messages?: { messages?: unknown[] } | unknown[] };
  if (Array.isArray(d?.messages)) return d.messages;
  const anidado = (d?.messages as { messages?: unknown[] })?.messages;
  return Array.isArray(anidado) ? anidado : [];
}

function aMensajeReal(crudo: unknown): MensajeReal | null {
  const m = crudo as {
    id?: string; messageType?: string; direction?: string;
    body?: string; attachments?: unknown;
  };
  if (!m?.id || !esMensajeReal(m.messageType)) return null;

  return {
    id: m.id,
    tipo: m.messageType,
    // Si `direction` llega ausente o ilegible, se asume SALIENTE. Es el sesgo
    // seguro en las DOS guardas: un mensaje ambiguo al final hace que el agente
    // no responda, y `huboRespuestaHumana` lo cuenta como humano y lo calla.
    // Al revés sería peor de lo que parece — un saliente PROPIO con la dirección
    // corrupta se leería como entrante, el agente se contestaría a sí mismo, y
    // esa respuesta volvería a entrar por el webhook: bucle infinito pagando
    // cada vuelta.
    direccion: m.direction === 'inbound' ? 'inbound' : 'outbound',
    texto: typeof m.body === 'string' ? m.body : '',
    adjuntos: Array.isArray(m.attachments)
      ? m.attachments.filter((a): a is string => typeof a === 'string')
      : [],
  };
}

function fechaDe(crudo: unknown): number {
  const t = Date.parse((crudo as { dateAdded?: string })?.dateAdded ?? '');
  return Number.isNaN(t) ? 0 : t;
}

// Un reintento y sólo uno, ante un fallo de red o un 5xx. Un 4xx no se
// reintenta: un problema de permisos o de parámetros no mejora insistiendo,
// y el cliente estaría esperando mientras tanto.
async function pedir(url: string, apiKey: string, fetchImpl: typeof fetch): Promise<Response> {
  try {
    const res = await fetchImpl(url, { headers: cabeceras(apiKey) });
    if (res.status < 500) return res;
  } catch {
    // Cae al reintento de abajo. Si ese también falla, lo recoge el try/catch
    // de hidratar.
  }
  await new Promise((r) => setTimeout(r, 400));
  return fetchImpl(url, { headers: cabeceras(apiKey) });
}

export async function hidratar(contactId: string, deps: DepsGhl): Promise<Resultado> {
  const { apiKey, locationId, fetchImpl = fetch } = deps;

  try {
    const busqueda = await pedir(
      `${config.BASE_GHL}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}`,
      apiKey, fetchImpl,
    );
    const textoBusqueda = await busqueda.text();
    if (!busqueda.ok) {
      return { ok: false, error: `GHL search ${busqueda.status}: ${textoBusqueda.slice(0, 200)}` };
    }

    const conversationId = (
      JSON.parse(textoBusqueda) as { conversations?: { id?: string }[] }
    ).conversations?.[0]?.id;
    if (!conversationId) {
      return { ok: false, error: 'El contacto no tiene ninguna conversación en GHL.' };
    }

    const res = await pedir(
      `${config.BASE_GHL}/conversations/${conversationId}/messages?limit=20`,
      apiKey, fetchImpl,
    );
    const texto = await res.text();
    if (!res.ok) {
      return { ok: false, error: `GHL messages ${res.status}: ${texto.slice(0, 200)}` };
    }

    // Ordenamos nosotros en vez de confiar en el orden de GHL: toda la guarda
    // anti-bucle depende de saber con certeza cuál es el último mensaje, y un
    // cambio de orden en la API la rompería en silencio.
    const mensajes = extraerCrudos(JSON.parse(texto))
      .slice()
      .sort((a, b) => fechaDe(a) - fechaDe(b))
      .map(aMensajeReal)
      .filter((m): m is MensajeReal => m !== null);

    return { ok: true, conversacion: { conversationId, mensajes } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function ultimoReal(c: Conversacion): MensajeReal | undefined {
  return c.mensajes[c.mensajes.length - 1];
}

// Guarda 2. Cualquier saliente de canal real cuyo id no esté en `enviados`
// lo escribió una persona del equipo. Equivocarse aquí significa el bot
// hablándole encima al asesor delante del cliente, así que ante la duda
// (un id que no pudimos registrar) esta función dice que sí hubo humano
// y el agente calla de más — que es el fallo seguro.
//
// Sólo cuentan los salientes POSTERIORES al último entrante. Un correo que un
// asesor mandó hace meses, antes de que esta persona escribiera, es historia y
// no una toma de control: con la base comercial entrando en prospección manual,
// mirar la conversación entera dejaría mudo al agente en todo contacto que un
// asesor hubiera tocado alguna vez.
//
// La permanencia no la da este escaneo sino el latch de estado: en cuanto se
// detecta, el contacto pasa a 'humano' y procesar() ni vuelve a hidratarlo.
export function huboRespuestaHumana(c: Conversacion, enviados: string[]): boolean {
  const ultimoEntrante = c.mensajes.map((m) => m.direccion).lastIndexOf('inbound');
  // Sin ningún entrante no hay conversación que nadie pueda haber tomado.
  if (ultimoEntrante === -1) return false;

  const mios = new Set(enviados);
  return c.mensajes
    .slice(ultimoEntrante + 1)
    .some((m) => m.direccion === 'outbound' && !mios.has(m.id));
}
