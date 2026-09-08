// tests/campanas-contactos.test.ts
import { describe, it, expect, vi } from 'vitest';
import { contactosPorZona, conCorreo, ZONAS_COMERCIALES, type ContactoZona } from '@/lib/campanas/contactos';

const deps = { apiKey: 'llave', locationId: 'loc-1' };

function respuesta(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe('ZONAS_COMERCIALES', () => {
  it('son exactamente las 13 zonas del campo personalizado', () => {
    expect(ZONAS_COMERCIALES).toEqual([
      'GAM Oeste',
      'GAM Centro',
      'GAM Este / Cartago',
      'Heredia / Norte GAM',
      'Alajuela / Occidente',
      'Zona Norte',
      'Guanacaste Costa',
      'Guanacaste Interior',
      'Península Nicoya',
      'Pacífico Central',
      'Pacífico Sur',
      'Caribe',
      'Revisión manual',
    ]);
  });
});

describe('contactosPorZona', () => {
  it('pide POST /contacts/search con la Version, el locationId y el filtro por zona', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ contacts: [] }));
    await contactosPorZona('GAM Oeste', { ...deps, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opciones] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://services.leadconnectorhq.com/contacts/search');
    expect(opciones.method).toBe('POST');
    expect(opciones.headers.Version).toBe('2021-07-28');
    expect(opciones.headers.Authorization).toBe('Bearer llave');

    const cuerpo = JSON.parse(opciones.body);
    expect(cuerpo.locationId).toBe('loc-1');
    expect(cuerpo.filters).toEqual([
      { field: 'customFields.zona_comercial', operator: 'eq', value: 'GAM Oeste' },
    ]);
  });

  it('mapea id, firstName y email de cada contacto', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      respuesta({
        contacts: [
          { id: 'c-1', firstName: 'Ana Rodríguez', email: 'ana@hotel.com' },
          { id: 'c-2', firstName: 'supermercado poval', email: 'facturas@poval.cr' },
        ],
      }),
    );
    const r = await contactosPorZona('GAM Oeste', { ...deps, fetchImpl });
    expect(r).toEqual({
      ok: true,
      contactos: [
        { contactId: 'c-1', nombreCrm: 'Ana Rodríguez', correo: 'ana@hotel.com' },
        { contactId: 'c-2', nombreCrm: 'supermercado poval', correo: 'facturas@poval.cr' },
      ],
    });
  });

  it('un contacto sin correo queda con correo: null, no se descarta', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      respuesta({ contacts: [{ id: 'c-1', firstName: 'Hotel Sin Correo' }] }),
    );
    const r = await contactosPorZona('GAM Oeste', { ...deps, fetchImpl });
    expect(r).toEqual({
      ok: true,
      contactos: [{ contactId: 'c-1', nombreCrm: 'Hotel Sin Correo', correo: null }],
    });
  });

  it('un contacto sin id se descarta (no hay nada que hacer con él)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      respuesta({ contacts: [{ firstName: 'Sin Id' }, { id: 'c-1', firstName: 'Con Id' }] }),
    );
    const r = await contactosPorZona('GAM Oeste', { ...deps, fetchImpl });
    expect(r).toEqual({ ok: true, contactos: [{ contactId: 'c-1', nombreCrm: 'Con Id', correo: null }] });
  });

  it('pagina: sigue pidiendo páginas hasta que una vuelve con menos de 100 contactos', async () => {
    const pagina1 = { contacts: Array.from({ length: 100 }, (_, i) => ({ id: `c-${i}`, email: `a${i}@x.cr` })) };
    const pagina2 = { contacts: [{ id: 'c-100', email: 'a100@x.cr' }] };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(respuesta(pagina1))
      .mockResolvedValueOnce(respuesta(pagina2));

    const r = await contactosPorZona('GAM Oeste', { ...deps, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.contactos).toHaveLength(101);

    const cuerpo1 = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const cuerpo2 = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(cuerpo1.page).toBe(1);
    expect(cuerpo2.page).toBe(2);
  });

  it('una página con exactamente 100 y la siguiente vacía: dos llamadas, sin colgarse', async () => {
    const pagina1 = { contacts: Array.from({ length: 100 }, (_, i) => ({ id: `c-${i}`, email: `a${i}@x.cr` })) };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(respuesta(pagina1))
      .mockResolvedValueOnce(respuesta({ contacts: [] }));

    const r = await contactosPorZona('GAM Oeste', { ...deps, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.contactos).toHaveLength(100);
  });

  it('un 4xx/5xx de GHL no lanza: devuelve ok:false con el status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respuesta({ message: 'no autorizado' }, 401));
    const r = await contactosPorZona('GAM Oeste', { ...deps, fetchImpl });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('401') });
  });

  it('un fallo de red no lanza', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('sin red'));
    const r = await contactosPorZona('GAM Oeste', { ...deps, fetchImpl });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('sin red') });
  });

  it('un JSON ilegible no lanza', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'no es json' });
    const r = await contactosPorZona('GAM Oeste', { ...deps, fetchImpl });
    expect(r.ok).toBe(false);
  });
});

describe('conCorreo', () => {
  const contactos: ContactoZona[] = [
    { contactId: 'c-1', nombreCrm: 'Ana', correo: 'ana@hotel.com' },
    { contactId: 'c-2', nombreCrm: 'Sin correo', correo: null },
    { contactId: 'c-3', nombreCrm: 'Beto', correo: 'beto@hotel.com' },
  ];

  it('deja sólo a quien tiene correo', () => {
    expect(conCorreo(contactos)).toEqual([
      { contactId: 'c-1', correo: 'ana@hotel.com', nombreCrm: 'Ana' },
      { contactId: 'c-3', correo: 'beto@hotel.com', nombreCrm: 'Beto' },
    ]);
  });

  it('con todos sin correo, devuelve una lista vacía', () => {
    expect(conCorreo([{ contactId: 'c-1', nombreCrm: 'X', correo: null }])).toEqual([]);
  });

  it('lista vacía entra y sale vacía', () => {
    expect(conCorreo([])).toEqual([]);
  });
});
