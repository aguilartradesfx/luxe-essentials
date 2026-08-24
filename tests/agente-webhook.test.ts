import { describe, it, expect, vi, beforeEach } from 'vitest';

// `after()` difiere el trabajo hasta después de la respuesta. En pruebas lo
// capturamos para poder ejecutarlo a mano y comprobar qué se agendó.
const tareas: (() => unknown)[] = [];
vi.mock('next/server', async (original) => {
  const real = await original<typeof import('next/server')>();
  return { ...real, after: (fn: () => unknown) => { tareas.push(fn); } };
});

vi.mock('@/lib/supabase/server', () => ({ supabaseAdmin: () => ({ from: () => ({}) }) }));

const procesar = vi.fn();
vi.mock('@/lib/agente/procesar', () => ({ procesar: (...a: unknown[]) => procesar(...a) }));

const { POST } = await import('@/app/api/ghl/webhook/route');

const SECRETO = 'secreto-de-prueba';

function peticion(cuerpo: unknown, secreto: string | null = SECRETO) {
  return new Request('http://localhost/api/ghl/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secreto === null ? {} : { 'x-luxe-agente-secreto': secreto }),
    },
    body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
  });
}

beforeEach(() => {
  tareas.length = 0;
  vi.clearAllMocks();
  procesar.mockResolvedValue({ desenlace: 'respondido' });
  process.env.LUXE_AGENTE_WEBHOOK_SECRET = SECRETO;
  process.env.LUXE_GHL_API_KEY = 'k';
  process.env.LUXE_GHL_LOCATION_ID = 'l';
  process.env.LUXE_ANTHROPIC_API_KEY = 'a';
  process.env.LUXE_OPENAI_API_KEY = 'o';
});

describe('POST /api/ghl/webhook', () => {
  it('rechaza sin cabecera secreta', async () => {
    const res = await POST(peticion({ contactId: 'c1' }, null));
    expect(res.status).toBe(401);
    expect(tareas).toHaveLength(0);
  });

  it('rechaza con secreto equivocado', async () => {
    const res = await POST(peticion({ contactId: 'c1' }, 'otro'));
    expect(res.status).toBe(401);
  });

  it('rechaza si el secreto no está configurado en el servidor', async () => {
    delete process.env.LUXE_AGENTE_WEBHOOK_SECRET;
    const res = await POST(peticion({ contactId: 'c1' }));
    expect(res.status).toBe(401);
  });

  // Responder rápido es el punto: si tardamos, GHL reintenta y el cliente
  // recibe dos respuestas.
  it('responde 200 y agenda el trabajo en vez de esperarlo', async () => {
    const res = await POST(peticion({ contactId: 'c1' }));
    expect(res.status).toBe(200);
    expect(procesar).not.toHaveBeenCalled();
    expect(tareas).toHaveLength(1);

    await tareas[0]();
    expect(procesar).toHaveBeenCalledWith('c1', expect.objectContaining({ ghlApiKey: 'k', locationId: 'l' }));
  });

  it('encuentra el contactId en las formas que manda GHL', async () => {
    for (const cuerpo of [
      { contactId: 'c1' },
      { contact_id: 'c1' },
      { contact: { id: 'c1' } },
      { customData: { contactId: 'c1' } },
    ]) {
      tareas.length = 0;
      vi.clearAllMocks();
      procesar.mockResolvedValue({ desenlace: 'respondido' });
      await POST(peticion(cuerpo));
      await tareas[0]?.();
      expect(procesar).toHaveBeenCalledWith('c1', expect.anything());
    }
  });

  // 200 y no 4xx: un cuerpo irreparable no debe hacer que GHL reintente en bucle.
  it('acepta sin agendar cuando no viene contactId', async () => {
    const res = await POST(peticion({ hola: 'mundo' }));
    expect(res.status).toBe(200);
    expect(tareas).toHaveLength(0);
  });

  it('acepta sin agendar cuando el cuerpo no es JSON', async () => {
    const res = await POST(peticion('esto no es json'));
    expect(res.status).toBe(200);
    expect(tareas).toHaveLength(0);
  });

  it('un fallo dentro del trabajo diferido no propaga', async () => {
    procesar.mockRejectedValue(new Error('boom'));
    await POST(peticion({ contactId: 'c1' }));
    await expect(tareas[0]()).resolves.not.toThrow();
  });
});
