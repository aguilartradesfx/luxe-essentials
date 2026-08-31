import { describe, it, expect, vi } from 'vitest';
import { enviarInvitacion } from '@/lib/cotizador/correo-invitacion';
import { HORAS_VIGENCIA } from '@/lib/cotizador/invitaciones';

// Mismo criterio que tests/panel-correo.test.ts para `enviarCotizacion`:
// nunca se llama a la API de Resend de verdad, todo pasa por `fetchImpl`
// inyectado.
const params = { para: 'nueva@luxe.cr', nombre: 'Marta Vargas', enlace: 'abc123' };
const deps = { apiKey: 'llave', remitente: 'Luxe Essentials <cotizaciones@luxe.cr>' };

function respuesta(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe('enviarInvitacion', () => {
  it('devuelve el id de Resend', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_123' }));
    const r = await enviarInvitacion(params, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, resendId: 're_123' });
  });

  it('manda al correo de la persona invitada, desde el remitente configurado, con el asunto fijo', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarInvitacion(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.to).toEqual(['nueva@luxe.cr']);
    expect(cuerpo.from).toBe(deps.remitente);
    expect(cuerpo.subject).toBe('Tu acceso al cotizador de Luxe Essentials');
  });

  it('el html lleva el enlace, la paleta de la marca y la vigencia', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://luxeessentialscr.com';
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarInvitacion(params, { ...deps, fetchImpl });
    const { html } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(html).toContain('https://luxeessentialscr.com/cotizador/clave?enlace=abc123');
    expect(html).toContain('#2F4156');
    expect(html).toContain('#567C8D');
    expect(html).toContain('#F5EFEB');
    expect(html).toContain(`${HORAS_VIGENCIA} horas`);
  });

  // Sin versión de texto, el correo puntúa peor en los filtros de spam — el
  // dominio de envío es nuevo y todavía no tiene reputación.
  it('incluye siempre una versión de texto plano, con el enlace', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarInvitacion(params, { ...deps, fetchImpl });
    const { text } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('/cotizador/clave?enlace=abc123');
    expect(text).not.toMatch(/<[a-z][\s\S]*>/i);
  });

  it('devuelve el error de Resend sin lanzar', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ message: 'dominio no verificado' }, 403));
    const r = await enviarInvitacion(params, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('403');
  });

  it('no lanza si se cae la red', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const r = await enviarInvitacion(params, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('ECONNRESET') });
  });

  it('falla claro si falta la llave, sin llegar a llamar a Resend', async () => {
    const fetchImpl = vi.fn();
    const r = await enviarInvitacion(params, { apiKey: '', remitente: deps.remitente, fetchImpl });
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falla claro si falta el remitente, sin llegar a llamar a Resend', async () => {
    const fetchImpl = vi.fn();
    const r = await enviarInvitacion(params, { apiKey: deps.apiKey, remitente: '', fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/LUXE_CORREO_REMITENTE/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
