import { describe, it, expect, vi } from 'vitest';
import { generar } from '@/lib/agente/cerebro';
import { DATOS_VACIOS } from '@/lib/agente/estado';

const deps = { anthropicKey: 'sk-ant-prueba' };

const entrada = {
  mensajes: [
    { id: 'm1', tipo: 'TYPE_WHATSAPP' as const, direccion: 'inbound' as const,
      texto: 'Hola, necesito uniformes', adjuntos: [] },
  ],
  mios: [] as string[],
  transcripciones: [],
  bloques: [],
  datosPrevios: DATOS_VACIOS,
  huboFallosDeMedios: false,
  esCorreo: false,
};

function claude(payload: unknown, stopReason = 'end_turn') {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        stop_reason: stopReason,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      }),
  });
}

describe('generar', () => {
  it('devuelve la respuesta y los datos extraídos', async () => {
    const fetchImpl = claude({
      respuesta: 'Con gusto. ¿Me compartes tu nombre?',
      datos: { ...DATOS_VACIOS, producto: 'uniformes' },
    });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.salida.respuesta).toContain('nombre');
    expect(r.salida.datos.producto).toBe('uniformes');
  });

  it('usa Opus 5 con effort low y max_tokens acotado', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(entrada, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe('claude-opus-5');
    expect(body.max_tokens).toBe(1024);
    expect(body.output_config.effort).toBe('low');
  });

  // Apagar el thinking en Opus 5 hace que la salida estructurada salga a veces
  // como texto plano: el turno "funciona", el JSON nunca llega y no hay error.
  // El parámetro simplemente no debe ir.
  it('no manda el parámetro thinking', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(entrada, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.thinking).toBeUndefined();
  });

  it('cachea el bloque de sistema', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(entrada, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('manda las cabeceras que exige la API de Anthropic', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(entrada, { ...deps, fetchImpl });
    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBe('sk-ant-prueba');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('adjunta los bloques de imagen al último turno del cliente', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(
      { ...entrada, bloques: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
      { ...deps, fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const ultimo = body.messages[body.messages.length - 1];
    expect(ultimo.content.some((b: { type: string }) => b.type === 'image')).toBe(true);
  });

  it('inyecta la transcripción del audio como texto del cliente', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar({ ...entrada, transcripciones: ['Quiero 200 filipinas'] }, { ...deps, fetchImpl });
    expect(JSON.stringify(fetchImpl.mock.calls[0][1].body)).toContain('Quiero 200 filipinas');
  });

  it('falla limpio cuando Claude devuelve un JSON que no valida', async () => {
    const fetchImpl = claude({ respuesta: 123, datos: 'no es un objeto' });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  it('falla limpio cuando el contenido no es JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'lo siento, no puedo' }] }),
    });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  // Un refusal llega con HTTP 200 y content vacío. Leer content[0].text sin
  // mirar stop_reason revienta con un TypeError críptico.
  it('trata el refusal como fallo, no como respuesta', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ stop_reason: 'refusal', content: [] }),
    });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('refusal');
  });

  // El mensaje del SyntaxError de JSON.parse arrastra la entrada, y ahí va
  // texto derivado de lo que escribió el cliente. Ese error va al log.
  it('no filtra la salida del modelo en el mensaje de error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Ana Pérez, ana@hotelx.com, +506 8888 8888' }],
        }),
    });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).not.toContain('ana@hotelx.com');
    expect(r.error).not.toContain('Ana Pérez');
  });

  it('rechaza una respuesta más larga de lo que cabe en un mensaje', async () => {
    const fetchImpl = claude({ respuesta: 'a'.repeat(1501), datos: DATOS_VACIOS });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  it('falla limpio cuando la red se cae, sin lanzar', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  // La API exige que el primer turno sea del usuario.
  it('descarta los turnos assistant iniciales', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar(
      {
        ...entrada,
        mensajes: [
          { id: 'o1', tipo: 'TYPE_WHATSAPP' as const, direccion: 'outbound' as const, texto: 'anterior', adjuntos: [] },
          { id: 'i1', tipo: 'TYPE_WHATSAPP' as const, direccion: 'inbound' as const, texto: 'hola', adjuntos: [] },
        ],
      },
      { ...deps, fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages[0].role).toBe('user');
  });

  it('inserta un turno mínimo cuando no queda ningún mensaje', async () => {
    const fetchImpl = claude({ respuesta: 'ok', datos: DATOS_VACIOS });
    await generar({ ...entrada, mensajes: [] }, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
  });

  it('falla limpio cuando la API responde 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' });
    const r = await generar(entrada, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('429');
  });
});
