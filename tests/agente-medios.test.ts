import { describe, it, expect, vi } from 'vitest';
import { prepararMedios } from '@/lib/agente/medios';

const deps = { openaiKey: 'sk-prueba' };

function descarga(bytes: number, contentType: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => new ArrayBuffer(bytes),
  };
}

function transcripcion(texto: string) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ text: texto }) };
}

describe('prepararMedios', () => {
  it('convierte una imagen en bloque base64 para Claude', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(descarga(10, 'image/jpeg'));
    const r = await prepararMedios(['https://cdn/foto.jpg'], { ...deps, fetchImpl });
    expect(r.bloques).toHaveLength(1);
    expect(r.bloques[0].source.media_type).toBe('image/jpeg');
    expect(typeof r.bloques[0].source.data).toBe('string');
    expect(r.fallos).toBe(0);
  });

  it('transcribe un audio y no lo manda como imagen', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(descarga(10, 'audio/ogg'))
      .mockResolvedValueOnce(transcripcion('Necesito cotizar 200 filipinas'));
    const r = await prepararMedios(['https://cdn/nota.ogg'], { ...deps, fetchImpl });
    expect(r.transcripciones).toEqual(['Necesito cotizar 200 filipinas']);
    expect(r.bloques).toHaveLength(0);
  });

  it('deduce el tipo por la extensión cuando el content-type no sirve', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(descarga(10, 'application/octet-stream'))
      .mockResolvedValueOnce(transcripcion('hola'));
    const r = await prepararMedios(['https://cdn/nota.m4a'], { ...deps, fetchImpl });
    expect(r.transcripciones).toEqual(['hola']);
  });

  // Claude rechaza imágenes por encima de ~5 MB. Mandarla igual es un 400 que
  // tumbaría la respuesta entera por una foto; mejor perder la foto.
  it('descarta una imagen demasiado grande y lo cuenta como fallo', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(descarga(6 * 1024 * 1024, 'image/png'));
    const r = await prepararMedios(['https://cdn/enorme.png'], { ...deps, fetchImpl });
    expect(r.bloques).toHaveLength(0);
    expect(r.fallos).toBe(1);
  });

  it('un adjunto que falla no arrastra a los demás', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(descarga(10, 'image/png'));
    const r = await prepararMedios(['https://cdn/rota.png', 'https://cdn/buena.png'], { ...deps, fetchImpl });
    expect(r.bloques).toHaveLength(1);
    expect(r.fallos).toBe(1);
  });

  it('cuenta como fallo el audio cuando Whisper devuelve error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(descarga(10, 'audio/ogg'))
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    const r = await prepararMedios(['https://cdn/nota.ogg'], { ...deps, fetchImpl });
    expect(r.transcripciones).toEqual([]);
    expect(r.fallos).toBe(1);
  });

  it('ignora los tipos que no sabe tratar sin contarlos como fallo del cliente', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(descarga(10, 'application/pdf'));
    const r = await prepararMedios(['https://cdn/catalogo.pdf'], { ...deps, fetchImpl });
    expect(r.bloques).toHaveLength(0);
    expect(r.transcripciones).toEqual([]);
  });

  it('no llama a la red cuando no hay adjuntos', async () => {
    const fetchImpl = vi.fn();
    const r = await prepararMedios([], { ...deps, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r).toEqual({ bloques: [], transcripciones: [], fallos: 0 });
  });
});
