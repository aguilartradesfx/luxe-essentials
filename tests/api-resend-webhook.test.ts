// tests/api-resend-webhook.test.ts
//
// POST /api/resend/webhook -- la cáscara: secreto (falla cerrada), firma,
// y qué responde ante cada desenlace de la base. La lógica de fondo
// (repetido, desordenado, desconocido) la verifica
// scripts/verificar-resend-webhook.mjs contra la base real, con rollback.
// Nunca se llama a Resend ni a Supabase de verdad.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

const rpc = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ supabaseAdmin: () => ({ rpc, from: vi.fn() }) }));

const modulo = await import('@/app/api/resend/webhook/route');
const { POST } = modulo;

const CLAVE = Buffer.from('una-clave-de-prueba-de-32-bytes!!');
const SECRETO = `whsec_${CLAVE.toString('base64')}`;
const CUERPO = JSON.stringify({
  type: 'email.bounced',
  created_at: '2026-10-01T10:00:05.000Z',
  data: { email_id: 'em_9', created_at: '2026-10-01T09:00:00.000Z', bounce: { type: 'Permanent', subType: 'General', message: 'no existe' } },
});

function peticion(opciones: { cuerpo?: string; id?: string | null; ts?: number | string; firma?: string | null; clave?: Buffer } = {}) {
  const cuerpo = opciones.cuerpo ?? CUERPO;
  const id = opciones.id === undefined ? 'msg_1' : opciones.id;
  const ts = opciones.ts ?? Math.floor(Date.now() / 1000);
  const firma =
    opciones.firma === undefined
      ? `v1,${createHmac('sha256', opciones.clave ?? CLAVE).update(`${id}.${ts}.${cuerpo}`).digest('base64')}`
      : opciones.firma;
  const h: Record<string, string> = { 'svix-timestamp': String(ts) };
  if (id) h['svix-id'] = id;
  if (firma) h['svix-signature'] = firma;
  return new Request('https://luxeessentialscr.com/api/resend/webhook', { method: 'POST', headers: h, body: cuerpo });
}

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: 'aplicado', error: null });
  process.env.RESEND_WEBHOOK_SECRET = SECRETO;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.RESEND_WEBHOOK_SECRET;
});

describe('falla cerrada sin RESEND_WEBHOOK_SECRET', () => {
  it('500 y no toca la base, aunque la firma esté "bien" hecha con una clave vacía', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const res = await POST(peticion({ clave: Buffer.alloc(0) }));
    expect(res.status).toBe(500);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('un secreto vacío ("") cuenta como no configurado', async () => {
    process.env.RESEND_WEBHOOK_SECRET = '';
    expect((await POST(peticion())).status).toBe(500);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('firma', () => {
  it('firma correcta: 200 y registra el evento', async () => {
    const res = await POST(peticion());
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('firma incorrecta: 401, sin tocar la base', async () => {
    const res = await POST(peticion({ clave: Buffer.from('otra-clave-distinta-de-32-bytes!') }));
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('sin cabeceras de Svix: 401', async () => {
    expect((await POST(peticion({ id: null, firma: null }))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('marca de tiempo vieja (repetición de una captura): 401', async () => {
    const res = await POST(peticion({ ts: Math.floor(Date.now() / 1000) - 3600 }));
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('la firma cubre el cuerpo crudo: cambiar el cuerpo después de firmar da 401', async () => {
    const firmada = peticion();
    const firma = firmada.headers.get('svix-signature')!;
    const ts = firmada.headers.get('svix-timestamp')!;
    const req = new Request('https://luxeessentialscr.com/api/resend/webhook', {
      method: 'POST',
      headers: { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': firma },
      body: CUERPO.replace('em_9', 'em_8'),
    });
    expect((await POST(req)).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('qué se guarda y qué se responde', () => {
  it('pasa a la rpc el svix-id, el tipo, el correo de Resend y la hora del EVENTO', async () => {
    await POST(peticion({ id: 'msg_77' }));
    expect(rpc).toHaveBeenCalledWith('resend_registrar_evento', {
      p_svix_id: 'msg_77',
      p_tipo: 'email.bounced',
      p_resend_id: 'em_9',
      p_ocurrido_at: '2026-10-01T10:00:05.000Z',
      p_detalle: { bounce_tipo: 'Permanent', bounce_subtipo: 'General', mensaje: 'no existe' },
    });
  });

  it('evento repetido: 200 (para que Svix deje de reintentar)', async () => {
    rpc.mockResolvedValue({ data: 'duplicado', error: null });
    const res = await POST(peticion());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, resultado: 'duplicado' });
  });

  it('correo que no conocemos (cotización, invitación): 200, no revienta', async () => {
    rpc.mockResolvedValue({ data: 'huerfano', error: null });
    const res = await POST(peticion());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, resultado: 'huerfano' });
  });

  it('si la base falla: 500, para que Svix reintente (es seguro: el svix-id lo hace idempotente)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'caida' } });
    expect((await POST(peticion())).status).toBe(500);
  });

  it('si la rpc lanza una excepción: 500, no un 200 mudo', async () => {
    rpc.mockRejectedValue(new Error('red'));
    expect((await POST(peticion())).status).toBe(500);
  });

  it('un tipo de evento que no usamos: 200 sin tocar la base', async () => {
    const cuerpo = JSON.stringify({ type: 'domain.updated', created_at: '2026-10-01T10:00:00Z', data: {} });
    const res = await POST(peticion({ cuerpo }));
    expect(res.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('JSON roto pero bien firmado: 200 (reintentarlo no lo arregla), sin tocar la base', async () => {
    const res = await POST(peticion({ cuerpo: 'no es json' }));
    expect(res.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
  });

  // Responde rápido: sin trabajo diferido ni límites ampliados.
  it('no pide más tiempo del normal: una sola rpc y nada más', async () => {
    expect((modulo as Record<string, unknown>).maxDuration).toBeUndefined();
    await POST(peticion());
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
