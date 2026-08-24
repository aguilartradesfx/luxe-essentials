import { describe, it, expect, vi } from 'vitest';
import { hidratar, ultimoReal, huboRespuestaHumana } from '@/lib/agente/conversacion';
import type { Conversacion } from '@/lib/agente/conversacion';

const deps = { apiKey: 'llave', locationId: 'ubicacion' };

// Simula las dos llamadas en cadena: primero /conversations/search, luego
// /conversations/{id}/messages.
function ghl(busqueda: unknown, mensajes: unknown) {
  return vi
    .fn()
    .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(busqueda) })
    .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(mensajes) });
}

const UNA_CONVERSACION = { conversations: [{ id: 'conv-1' }] };

function msg(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    messageType: 'TYPE_WHATSAPP',
    direction: 'inbound',
    body: 'Hola',
    dateAdded: '2026-08-24T10:00:00.000Z',
    attachments: [],
    ...over,
  };
}

describe('hidratar', () => {
  it('devuelve los mensajes reales de la conversación', async () => {
    const fetchImpl = ghl(UNA_CONVERSACION, { messages: { messages: [msg()] } });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conversacion.conversationId).toBe('conv-1');
    expect(r.conversacion.mensajes).toHaveLength(1);
    expect(r.conversacion.mensajes[0].texto).toBe('Hola');
  });

  it('acepta también la forma plana del array de mensajes', async () => {
    const fetchImpl = ghl(UNA_CONVERSACION, { messages: [msg()] });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok && r.conversacion.mensajes).toHaveLength(1);
  });

  // El caso que motiva el proyecto entero.
  it('descarta las actividades del CRM y deja la conversación vacía', async () => {
    const fetchImpl = ghl(UNA_CONVERSACION, {
      messages: {
        messages: [
          msg({ id: 'a1', messageType: 'TYPE_ACTIVITY_OPPORTUNITY', direction: 'outbound', body: 'Opportunity created' }),
          msg({ id: 'a2', messageType: 'TYPE_ACTIVITY_CONTACT', direction: 'inbound', body: 'DnD enabled by customer' }),
        ],
      },
    });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conversacion.mensajes).toEqual([]);
  });

  // No confiamos en el orden que devuelva GHL. Ordenamos nosotros por fecha,
  // porque toda la guarda anti-bucle depende de saber cuál es el ÚLTIMO.
  it('ordena por fecha ascendente sin importar cómo lleguen', async () => {
    const fetchImpl = ghl(UNA_CONVERSACION, {
      messages: {
        messages: [
          msg({ id: 'nuevo', dateAdded: '2026-08-24T12:00:00.000Z', body: 'segundo' }),
          msg({ id: 'viejo', dateAdded: '2026-08-24T09:00:00.000Z', body: 'primero' }),
        ],
      },
    });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    if (!r.ok) throw new Error('debía hidratar');
    expect(r.conversacion.mensajes.map((m) => m.id)).toEqual(['viejo', 'nuevo']);
  });

  it('conserva los adjuntos', async () => {
    const fetchImpl = ghl(UNA_CONVERSACION, {
      messages: { messages: [msg({ attachments: ['https://cdn/x.ogg'] })] },
    });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok && r.conversacion.mensajes[0].adjuntos).toEqual(['https://cdn/x.ogg']);
  });

  it('falla limpio cuando el contacto no tiene conversación', async () => {
    const fetchImpl = ghl({ conversations: [] }, {});
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  it('falla limpio cuando GHL devuelve un error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'no autorizado' });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('401');
  });

  // El spec §10 pide un reintento con espera antes de rendirse: un 5xx puntual
  // de GHL no debería costarle la respuesta al cliente.
  it('reintenta una vez ante un 5xx y sale adelante', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'boom' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(UNA_CONVERSACION) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ messages: { messages: [msg()] } }) });
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('no reintenta un 401: reintentar un problema de permisos sólo gasta tiempo', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'no autorizado' });
    await hidratar('c1', { ...deps, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falla limpio cuando la red se cae, sin lanzar', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const r = await hidratar('c1', { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  it('manda el bearer y la versión de conversaciones', async () => {
    const fetchImpl = ghl(UNA_CONVERSACION, { messages: { messages: [] } });
    await hidratar('c1', { ...deps, fetchImpl });
    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer llave');
    expect(headers.Version).toBe('2021-04-15');
  });
});

function conv(mensajes: Conversacion['mensajes']): Conversacion {
  return { conversationId: 'conv-1', mensajes };
}

const real = (over: Partial<Conversacion['mensajes'][number]> = {}) => ({
  id: 'm', tipo: 'TYPE_WHATSAPP' as const, direccion: 'inbound' as const,
  texto: 't', adjuntos: [], ...over,
});

describe('ultimoReal', () => {
  it('devuelve el último de la lista', () => {
    const c = conv([real({ id: 'a' }), real({ id: 'b' })]);
    expect(ultimoReal(c)?.id).toBe('b');
  });

  it('devuelve undefined si no hay ninguno', () => {
    expect(ultimoReal(conv([]))).toBeUndefined();
  });
});

describe('huboRespuestaHumana', () => {
  it('es falso cuando todos los salientes los mandó el agente', () => {
    const c = conv([real({ id: 'in' }), real({ id: 'mio', direccion: 'outbound' })]);
    expect(huboRespuestaHumana(c, ['mio'])).toBe(false);
  });

  // Si esto falla, el bot le habla encima al asesor delante del cliente.
  it('es verdadero cuando aparece un saliente que el agente no mandó', () => {
    const c = conv([real({ id: 'in' }), real({ id: 'del-asesor', direccion: 'outbound' })]);
    expect(huboRespuestaHumana(c, ['mio'])).toBe(true);
  });

  it('ignora los entrantes: el cliente nunca es "el humano" de esta guarda', () => {
    const c = conv([real({ id: 'x' }), real({ id: 'y' })]);
    expect(huboRespuestaHumana(c, [])).toBe(false);
  });
});
