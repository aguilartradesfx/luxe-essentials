// Las imágenes van directas a Claude, que las procesa de forma nativa.
// Sólo el audio necesita OpenAI: es lo único que Claude no puede leer.

export type BloqueImagen = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
};

export type Medios = {
  bloques: BloqueImagen[];
  transcripciones: string[];
  fallos: number;
};

type Deps = { openaiKey: string; fetchImpl?: typeof fetch };

// Claude rechaza imágenes por encima de ~5 MB con un 400 que tumbaría la
// respuesta entera. Whisper rechaza audio por encima de 25 MB. Perder el
// adjunto es preferible a perder la conversación.
const MAX_IMAGEN = 5 * 1024 * 1024;
const MAX_AUDIO = 25 * 1024 * 1024;

const IMAGENES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const EXT_IMAGEN: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp',
};
const EXT_AUDIO = ['ogg', 'oga', 'opus', 'mp3', 'm4a', 'wav', 'amr', 'mp4', 'webm'];

function extension(url: string): string {
  const limpia = url.split('?')[0].split('#')[0];
  return (limpia.split('.').pop() ?? '').toLowerCase();
}

function normalizar(contentType: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

const GENERICOS = ['', 'application/octet-stream', 'binary/octet-stream'];

// GHL no siempre manda un content-type útil (a veces application/octet-stream),
// así que la extensión de la URL es el desempate.
//
// 'otro' y 'desconocido' NO son lo mismo, y confundirlos costaría adjuntos:
// 'otro' es un tipo que identificamos y sabemos que no tratamos —un PDF seguirá
// siendo un PDF por mucho que el cliente lo reenvíe, así que no es un fallo
// suyo—, mientras que 'desconocido' es que ninguna de las dos señales dijo
// nada. Eso último pasa de verdad: las URLs del CDN de GHL vienen sin extensión
// (files.leadconnectorhq.com/uploads/abc123) y a veces con content-type
// genérico, así que una foto real puede caer aquí. Se cuenta como fallo para
// que el modelo sepa pedirla por escrito en vez de descartarla en silencio.
function clasificar(url: string, contentType: string | null): 'imagen' | 'audio' | 'otro' | 'desconocido' {
  const ct = normalizar(contentType);
  if (IMAGENES.includes(ct)) return 'imagen';
  if (ct.startsWith('audio/') || ct === 'video/mp4' || ct === 'video/webm') return 'audio';

  const ext = extension(url);
  if (EXT_IMAGEN[ext]) return 'imagen';
  if (EXT_AUDIO.includes(ext)) return 'audio';

  return GENERICOS.includes(ct) ? 'desconocido' : 'otro';
}

function tipoImagen(url: string, contentType: string | null): string {
  const ct = normalizar(contentType);
  if (IMAGENES.includes(ct)) return ct;
  return EXT_IMAGEN[extension(url)] ?? 'image/jpeg';
}

async function transcribir(
  bytes: ArrayBuffer, url: string, openaiKey: string, fetchImpl: typeof fetch,
): Promise<string | null> {
  const forma = new FormData();
  forma.append('file', new Blob([bytes]), `audio.${extension(url) || 'ogg'}`);
  forma.append('model', 'whisper-1');

  const res = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: forma,
  });
  if (!res.ok) return null;

  const texto = (JSON.parse(await res.text()) as { text?: string }).text;
  return typeof texto === 'string' && texto.trim() ? texto.trim() : null;
}

export async function prepararMedios(urls: string[], deps: Deps): Promise<Medios> {
  const { openaiKey, fetchImpl = fetch } = deps;
  const medios: Medios = { bloques: [], transcripciones: [], fallos: 0 };
  if (urls.length === 0) return medios;

  for (const url of urls) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) { medios.fallos += 1; continue; }

      const contentType = res.headers.get('content-type');
      const clase = clasificar(url, contentType);

      // Medir por la cabecera ANTES de traer el cuerpo: descargar 60 MB para
      // luego descartarlos gasta el presupuesto de ejecución de la función, que
      // es lo que corta los turnos a mitad.
      const declarado = Number(res.headers.get('content-length') ?? 0);
      const tope = clase === 'audio' ? MAX_AUDIO : MAX_IMAGEN;
      if (declarado > tope) {
        medios.fallos += 1;
        continue;
      }

      // Un PDF o un vCard no son un fallo del cliente: simplemente no sabemos
      // tratarlos y el modelo se las arregla con el texto del mensaje.
      if (clase === 'otro') continue;

      // Aquí, en cambio, no sabemos qué es. Podría ser una foto real que no
      // supimos reconocer, así que cuenta como fallo y el modelo pedirá el dato
      // por escrito en vez de perderlo sin que nadie se entere.
      if (clase === 'desconocido') {
        medios.fallos += 1;
        continue;
      }

      const bytes = await res.arrayBuffer();

      if (bytes.byteLength > tope) { medios.fallos += 1; continue; }

      if (clase === 'imagen') {
        medios.bloques.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: tipoImagen(url, contentType),
            data: Buffer.from(bytes).toString('base64'),
          },
        });
        continue;
      }

      const texto = await transcribir(bytes, url, openaiKey, fetchImpl);
      if (texto) medios.transcripciones.push(texto);
      else medios.fallos += 1;
    } catch {
      // Un adjunto roto no debe arrastrar a los demás ni impedir la respuesta.
      medios.fallos += 1;
    }
  }

  return medios;
}
