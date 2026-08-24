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
// respuesta entera. Perder la foto es preferible a perder la conversación.
const MAX_IMAGEN = 5 * 1024 * 1024;

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

// GHL no siempre manda un content-type útil (a veces application/octet-stream),
// así que la extensión de la URL es el desempate.
function clasificar(url: string, contentType: string | null): 'imagen' | 'audio' | 'otro' {
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (IMAGENES.includes(ct)) return 'imagen';
  if (ct.startsWith('audio/') || ct === 'video/mp4' || ct === 'video/webm') return 'audio';

  const ext = extension(url);
  if (EXT_IMAGEN[ext]) return 'imagen';
  if (EXT_AUDIO.includes(ext)) return 'audio';
  return 'otro';
}

function tipoImagen(url: string, contentType: string | null): string {
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();
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

      // Un PDF o un vCard no son un fallo del cliente: simplemente no sabemos
      // tratarlos y el modelo se las arregla con el texto del mensaje.
      if (clase === 'otro') continue;

      const bytes = await res.arrayBuffer();

      if (clase === 'imagen') {
        if (bytes.byteLength > MAX_IMAGEN) { medios.fallos += 1; continue; }
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
