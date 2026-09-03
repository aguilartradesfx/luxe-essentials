import { describe, it, expect, vi } from 'vitest';
import {
  enviarSolicitudAprobacion,
  enviarResolucionAprobacion,
  formatearDescuento,
} from '@/lib/cotizador/correo-aprobacion';

// Mismo criterio que tests/correo-invitacion.test.ts y
// tests/panel-correo.test.ts: nunca se llama a la API de Resend de verdad,
// todo pasa por `fetchImpl` inyectado.
const deps = { apiKey: 'llave', remitente: 'Luxe Essentials <cotizaciones@luxe.cr>' };
const cliente = { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' };

function respuesta(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe('formatearDescuento', () => {
  it('describe un descuento general', () => {
    expect(formatearDescuento({ general: 20 })).toContain('20%');
    expect(formatearDescuento({ general: 20 })).toMatch(/general/i);
  });

  it('describe un descuento por familia, con cada grupo y su porcentaje', () => {
    const texto = formatearDescuento({ familias: { 'sets-cama': 15, toallas: 10 } });
    expect(texto).toContain('sets-cama: 15%');
    expect(texto).toContain('toallas: 10%');
  });
});

describe('enviarSolicitudAprobacion', () => {
  const params = {
    para: ['ana@luxeessentialscr.com', 'beto@luxeessentialscr.com'],
    numero: 'COT-2026-0001',
    cliente,
    total: 1464480,
    descuentoPedido: { general: 20 },
    solicitadoPor: 'Guillermo Rojas',
  };

  it('devuelve el id de Resend', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    const r = await enviarSolicitudAprobacion(params, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, resendId: 're_1' });
  });

  it('manda a TODOS los destinatarios de "para" en un solo correo, desde el remitente configurado', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarSolicitudAprobacion(params, { ...deps, fetchImpl });
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.to).toEqual(['ana@luxeessentialscr.com', 'beto@luxeessentialscr.com']);
    expect(cuerpo.from).toBe(deps.remitente);
    expect(cuerpo.subject).toContain('COT-2026-0001');
  });

  it('el correo lleva el cliente, el descuento pedido, el monto y quién lo pidió', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarSolicitudAprobacion(params, { ...deps, fetchImpl });
    const { html, text } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    for (const cuerpo of [html, text]) {
      expect(cuerpo).toContain('Ana Pérez');
      expect(cuerpo).toContain('Hotel Papagayo');
      expect(cuerpo).toContain('general, 20%');
      expect(cuerpo).toContain('₡1.464.480');
      expect(cuerpo).toContain('Guillermo Rojas');
    }
  });

  it('el html lleva un enlace al panel', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://luxeessentialscr.com';
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarSolicitudAprobacion(params, { ...deps, fetchImpl });
    const { html } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(html).toContain('https://luxeessentialscr.com/cotizador');
  });

  // Ronda de correcciones 1 en correo-invitacion.ts, hallazgo importante:
  // `solicitadoPor` lo escribe OTRO usuario (el vendedor que pide el
  // descuento), no un dato del sistema -- es exactamente el tipo de valor
  // que no se puede interpolar crudo en HTML.
  it('escapa el nombre de quien solicita antes de interpolarlo en el html', async () => {
    const payload = '</p><a/href=https://sitio-falso.cr>Reclamá</a><p>';
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarSolicitudAprobacion({ ...params, solicitadoPor: payload }, { ...deps, fetchImpl });
    const { html } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(html).not.toMatch(/<a\/href=https:\/\/sitio-falso\.cr/i);
    expect(html).toContain('&lt;/p&gt;&lt;a/href=https://sitio-falso.cr&gt;');
  });

  it('escapa el nombre y la empresa del cliente antes de interpolarlos en el html', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarSolicitudAprobacion(
      { ...params, cliente: { ...cliente, nombre: payload, empresa: payload } },
      { ...deps, fetchImpl },
    );
    const { html } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(html).not.toMatch(/<img src=x onerror=/i);
  });

  it('rechaza sin destinatarios, sin llegar a llamar a Resend', async () => {
    const fetchImpl = vi.fn();
    const r = await enviarSolicitudAprobacion({ ...params, para: [] }, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falla claro si falta la llave, sin llegar a llamar a Resend', async () => {
    const fetchImpl = vi.fn();
    const r = await enviarSolicitudAprobacion(params, { apiKey: '', remitente: deps.remitente, fetchImpl });
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falla claro si falta el remitente, sin llegar a llamar a Resend', async () => {
    const fetchImpl = vi.fn();
    const r = await enviarSolicitudAprobacion(params, { apiKey: deps.apiKey, remitente: '', fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/LUXE_CORREO_REMITENTE/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('incluye siempre una versión de texto plano', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarSolicitudAprobacion(params, { ...deps, fetchImpl });
    const { text } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(typeof text).toBe('string');
    expect(text).not.toMatch(/<[a-z][\s\S]*>/i);
  });

  it('devuelve el error de Resend sin lanzar', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ message: 'dominio no verificado' }, 403));
    const r = await enviarSolicitudAprobacion(params, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('403');
  });

  it('no lanza si se cae la red', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const r = await enviarSolicitudAprobacion(params, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('ECONNRESET') });
  });
});

describe('enviarResolucionAprobacion', () => {
  const base = {
    para: 'guillermo@luxeessentialscr.com',
    numero: 'COT-2026-0001',
    cliente,
    descuentoPedido: { general: 20 },
    resueltoPor: 'Ana Solano',
  };

  it('aprobada sin cambio: NO destaca ningún cambio de porcentaje', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarResolucionAprobacion(
      { ...base, resultado: 'aprobada', descuentoAprobado: { general: 20 }, cambioPorcentaje: false },
      { ...deps, fetchImpl },
    );
    const { html, text, subject } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(subject).toContain('aprobada');
    expect(html).not.toMatch(/ojo/i);
    expect(text).not.toMatch(/ojo/i);
    expect(html).toContain('tal cual lo pediste');
  });

  // El caso que el diseño llama "el fallo más caro de todo este flujo":
  // pidió 20%, se aprobó 12%. Tiene que quedar destacado, con los dos
  // números, en los dos formatos.
  it('aprobada CON cambio: destaca lo pedido y lo aprobado, los dos números', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarResolucionAprobacion(
      { ...base, resultado: 'aprobada', descuentoAprobado: { general: 12 }, cambioPorcentaje: true },
      { ...deps, fetchImpl },
    );
    const { html, text } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    for (const cuerpo of [html, text]) {
      expect(cuerpo).toContain('general, 20%');
      expect(cuerpo).toContain('general, 12%');
    }
    expect(html).toMatch(/ojo/i);
  });

  it('rechazada: lleva el motivo', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarResolucionAprobacion(
      { ...base, resultado: 'rechazada', cambioPorcentaje: false, motivoRechazo: 'Margen insuficiente para este volumen' },
      { ...deps, fetchImpl },
    );
    const { html, text, subject } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(subject).toContain('rechazada');
    expect(html).toContain('Margen insuficiente para este volumen');
    expect(text).toContain('Margen insuficiente para este volumen');
  });

  it('rechazada sin motivo: no revienta ni imprime "undefined"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarResolucionAprobacion(
      { ...base, resultado: 'rechazada', cambioPorcentaje: false },
      { ...deps, fetchImpl },
    );
    const { html, text } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(html).not.toContain('undefined');
    expect(text).not.toContain('undefined');
  });

  it('manda a un único destinatario: el vendedor que pidió la cotización', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarResolucionAprobacion(
      { ...base, resultado: 'aprobada', descuentoAprobado: { general: 20 }, cambioPorcentaje: false },
      { ...deps, fetchImpl },
    );
    const cuerpo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cuerpo.to).toEqual(['guillermo@luxeessentialscr.com']);
  });

  it('escapa el motivo de rechazo antes de interpolarlo en el html', async () => {
    const payload = '</p><a/href=https://sitio-falso.cr>Reclamá</a><p>';
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarResolucionAprobacion(
      { ...base, resultado: 'rechazada', cambioPorcentaje: false, motivoRechazo: payload },
      { ...deps, fetchImpl },
    );
    const { html } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(html).not.toMatch(/<a\/href=https:\/\/sitio-falso\.cr/i);
    expect(html).toContain('&lt;/p&gt;&lt;a/href=https://sitio-falso.cr&gt;');
  });

  it('escapa quién resolvió antes de interpolarlo en el html', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ id: 're_1' }));
    await enviarResolucionAprobacion(
      { ...base, resultado: 'aprobada', descuentoAprobado: { general: 20 }, cambioPorcentaje: false, resueltoPor: payload },
      { ...deps, fetchImpl },
    );
    const { html } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(html).not.toMatch(/<img src=x onerror=/i);
  });

  it('falla claro si falta la llave, sin llegar a llamar a Resend', async () => {
    const fetchImpl = vi.fn();
    const r = await enviarResolucionAprobacion(
      { ...base, resultado: 'aprobada', descuentoAprobado: { general: 20 }, cambioPorcentaje: false },
      { apiKey: '', remitente: deps.remitente, fetchImpl },
    );
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('devuelve el error de Resend sin lanzar', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ message: 'dominio no verificado' }, 403));
    const r = await enviarResolucionAprobacion(
      { ...base, resultado: 'aprobada', descuentoAprobado: { general: 20 }, cambioPorcentaje: false },
      { ...deps, fetchImpl },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('403');
  });

  it('no lanza si se cae la red', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const r = await enviarResolucionAprobacion(
      { ...base, resultado: 'aprobada', descuentoAprobado: { general: 20 }, cambioPorcentaje: false },
      { ...deps, fetchImpl },
    );
    expect(r).toEqual({ ok: false, error: expect.stringContaining('ECONNRESET') });
  });
});
