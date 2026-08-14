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

  it('informa el error sin lanzar cuando la respuesta 200 trae JSON inválido', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'esto no es json',
    } as unknown as Response);
    const r = await upsertContact(lead, { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBeTruthy();
  });

  it('agrega una nota en español con la cantidad y el mensaje tras crear el contacto', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ contact: { id: 'abc123' } }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ note: { id: 'nota1' } }),
      } as unknown as Response);

    const r = await upsertContact(lead, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, contactId: 'abc123' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe('https://services.leadconnectorhq.com/contacts/abc123/notes');
    expect(init.headers.Authorization).toBe('Bearer llave');
    expect(init.headers.Version).toBe('2021-07-28');

    const notaBody = JSON.parse(init.body);
    expect(notaBody.body).toContain('300 piezas');
    expect(notaBody.body).toContain('Filipinas bordadas');
  });

  it('omite la nota cuando no hay mensaje ni cantidad', async () => {
    const leadSinDetalle = { ...lead, mensaje: '', cantidad: '' };
    const fetchImpl = respuesta({ contact: { id: 'abc123' } });
    const r = await upsertContact(leadSinDetalle, { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, contactId: 'abc123' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reporta notaError sin marcar ok:false cuando la API rechaza la nota', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ contact: { id: 'abc123' } }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ message: 'cuerpo inválido' }),
      } as unknown as Response);

    const r = await upsertContact(lead, { ...deps, fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.contactId).toBe('abc123');
    expect(r.ok === true && r.notaError).toMatch(/422/);
  });

  it('reporta notaError sin lanzar cuando la red falla al crear la nota', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ contact: { id: 'abc123' } }),
      } as unknown as Response)
      .mockRejectedValueOnce(new Error('sin conexión nota'));

    const r = await upsertContact(lead, { ...deps, fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.contactId).toBe('abc123');
    expect(r.ok === true && r.notaError).toMatch(/sin conexión nota/);
  });
});
