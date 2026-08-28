import { describe, it, expect, vi } from 'vitest';
import { enviarCotizacion } from '@/lib/cotizador/correo';

const params = {
  numero: 'COT-2026-0001',
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
  total: 1464480,
  vence: new Date('2026-09-26T12:00:00Z'),
  pdf: Buffer.from('%PDF-1.7 falso'),
  enlace: 'https://supabase/firmada',
};
const deps = { apiKey: 'llave', remitente: 'Luxe Essentials <cotizaciones@luxe.cr>' };

function respuesta(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe('enviarCotizacion', () => {
  it('devuelve el id de Resend', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_123' }));
    const r = await enviarCotizacion(params, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, resendId: 're_123' });
  });

  it('adjunta el PDF con nombre legible', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarCotizacion(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.attachments).toHaveLength(1);
    expect(cuerpo.attachments[0].filename).toBe('COT-2026-0001.pdf');
    expect(cuerpo.attachments[0].content).toBe(params.pdf.toString('base64'));
  });

  it('manda al correo del cliente, desde el remitente configurado', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarCotizacion(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.to).toEqual(['ana@hotel.com']);
    expect(cuerpo.from).toBe(deps.remitente);
  });

  it('el cuerpo lleva el monto, la vigencia y el enlace', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarCotizacion(params, { ...deps, fetchImpl });
    const { html } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(html).toContain('1.464.480');
    expect(html).toContain('https://supabase/firmada');
    expect(html).toMatch(/26.*setiembre|26\/09|2026-09-26/);
  });

  it('nunca menciona método de pago', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarCotizacion(params, { ...deps, fetchImpl });
    const cuerpo = fetchImpl.mock.calls[0][1].body as string;
    expect(cuerpo).not.toMatch(/pagar|pago en línea|tarjeta|transferencia/i);
  });

  it('devuelve error si Resend responde 2xx sin id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({}));
    const r = await enviarCotizacion(params, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });

  it('devuelve el error de Resend sin lanzar', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ message: 'dominio no verificado' }, 403));
    const r = await enviarCotizacion(params, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('403');
  });

  it('no lanza si se cae la red', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const r = await enviarCotizacion(params, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('ECONNRESET') });
  });

  it('falla claro si falta la llave', async () => {
    const fetchImpl = vi.fn();
    const r = await enviarCotizacion(params, { apiKey: '', remitente: deps.remitente, fetchImpl });
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
