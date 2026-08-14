import { describe, it, expect, vi } from 'vitest';
import { upsertContact } from '@/lib/ghl';

const lead = {
  nombre: 'Ana María Pérez',
  email: 'ana@empresa.com',
  telefono: '+502 5555 5555',
  empresa: 'Hotel Real',
  linea: 'uniformes' as const,
  cantidad: '300 piezas',
  mensaje: 'Filipinas bordadas',
};

const deps = { apiKey: 'llave', locationId: 'ubicacion' };

function respuesta(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

describe('upsertContact', () => {
  it('devuelve el id del contacto creado', async () => {
    const fetchImpl = respuesta({ contact: { id: 'abc123' } });
    const r = await upsertContact(lead, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, contactId: 'abc123' });
  });

  it('acepta también la forma plana de la respuesta', async () => {
    const fetchImpl = respuesta({ id: 'xyz789' });
    const r = await upsertContact(lead, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, contactId: 'xyz789' });
  });

  it('parte el nombre en nombre y apellidos', async () => {
    const fetchImpl = respuesta({ contact: { id: 'a' } });
    await upsertContact(lead, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.firstName).toBe('Ana');
    expect(body.lastName).toBe('María Pérez');
  });

  it('etiqueta el contacto con la línea de interés', async () => {
    const fetchImpl = respuesta({ contact: { id: 'a' } });
    await upsertContact(lead, { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tags).toContain('linea-uniformes');
    expect(body.tags).toContain('luxe-web');
  });

  it('manda la cabecera de versión y el bearer', async () => {
    const fetchImpl = respuesta({ contact: { id: 'a' } });
    await upsertContact(lead, { ...deps, fetchImpl });
    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer llave');
    expect(headers.Version).toBe('2021-07-28');
  });

  it('informa el error sin lanzar cuando la API rechaza', async () => {
    const fetchImpl = respuesta({ message: 'no autorizado' }, 401);
    const r = await upsertContact(lead, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/401/);
  });

  it('informa el error sin lanzar cuando la red falla', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('sin conexión'));
    const r = await upsertContact(lead, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/sin conexión/);
  });
});
