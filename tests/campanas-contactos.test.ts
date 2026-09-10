// tests/campanas-contactos.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  contactosPorZona,
  contactosDeTodasLasZonas,
  conCorreo,
  ZONAS_COMERCIALES,
  type ContactoZona,
} from '@/lib/campanas/contactos';

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

  // =====================================================================
  // El reintento -- hallazgo de producción (2026-09-10): "No se pudo
  // calcular la cola del envío programado" era un 400 pasajero de GHL en
  // esta misma llamada -- comprobado corriendo las trece zonas tres veces
  // en paralelo y una en serie, sin cambiar nada más: las cuatro salieron
  // limpias. Ver el comentario grande de `esFalloTransitorio` en
  // lib/campanas/contactos.ts para el criterio completo (distinto del de
  // lib/agente/conversacion.ts / acciones.ts, que nunca reintentan un 4xx).
  describe('reintento ante un fallo transitorio', () => {
    function respuestaCruda(status: number, cuerpo: unknown) {
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(cuerpo) } as unknown as Response;
    }

    it('un 400 con "try again" en el cuerpo se reintenta UNA vez y sale adelante', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          respuestaCruda(400, { status: 400, message: 'Failed to fetch details. Please try again later' }),
        )
        .mockResolvedValueOnce(respuestaCruda(200, { contacts: [{ id: 'c-1', email: 'a@x.cr' }] }));
      const r = await contactosPorZona('Pacífico Central', { ...deps, fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(r).toEqual({ ok: true, contactos: [{ contactId: 'c-1', nombreCrm: '', correo: 'a@x.cr' }] });
    });

    // Mata al mutante que reintentara CUALQUIER 400 a ciegas: un 400 real
    // (filtro mal armado, credencial rechazada con ese código) no mejora
    // insistiendo -- sale con UN solo intento, no dos.
    it('un 400 SIN "try again" -- un 400 de verdad -- no se reintenta', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(respuestaCruda(400, { status: 400, message: 'Invalid filter field' }));
      const r = await contactosPorZona('GAM Oeste', { ...deps, fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(r).toEqual({ ok: false, error: expect.stringContaining('400') });
    });

    it('un 401 (permisos) nunca se reintenta -- un intento y listo', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(respuestaCruda(401, { message: 'no autorizado' }));
      await contactosPorZona('GAM Oeste', { ...deps, fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('un 500 se reintenta una vez y sale adelante', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(respuestaCruda(500, { message: 'boom' }))
        .mockResolvedValueOnce(respuestaCruda(200, { contacts: [] }));
      const r = await contactosPorZona('GAM Oeste', { ...deps, fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(r).toEqual({ ok: true, contactos: [] });
    });

    it('un 429 se reintenta una vez y sale adelante', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(respuestaCruda(429, { message: 'rate limited' }))
        .mockResolvedValueOnce(respuestaCruda(200, { contacts: [] }));
      const r = await contactosPorZona('GAM Oeste', { ...deps, fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(r).toEqual({ ok: true, contactos: [] });
    });

    it('un fallo de red se reintenta una vez y sale adelante', async () => {
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(respuestaCruda(200, { contacts: [] }));
      const r = await contactosPorZona('GAM Oeste', { ...deps, fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(r).toEqual({ ok: true, contactos: [] });
    });

    // Mata al mutante que reintentara sin límite (un `for` sin corte, o un
    // `intento < 3`): si el segundo intento TAMBIÉN falla, se rinde -- dos
    // llamadas en total, nunca más, y devuelve el error del último intento.
    it('si el reintento TAMBIÉN falla, se rinde con dos llamadas en total -- nunca un bucle', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(respuestaCruda(500, { message: 'siempre cae' }));
      const r = await contactosPorZona('GAM Oeste', { ...deps, fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(r).toEqual({ ok: false, error: expect.stringContaining('500') });
    });

    it('si el reintento también es un fallo de red, se rinde con el mensaje de esa segunda falla', async () => {
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(new Error('primer intento cae'))
        .mockRejectedValueOnce(new Error('segundo intento tambien cae'));
      const r = await contactosPorZona('GAM Oeste', { ...deps, fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(r).toEqual({ ok: false, error: expect.stringContaining('segundo intento tambien cae') });
    });
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

// El camino compartido de ~47 peticiones que usa tanto
// app/api/campanas/zonas/route.ts como lib/campanas/cola.ts -- un solo
// lugar que lanza las trece consultas, en paralelo, sin dejar a ninguna
// esperando a otra.
describe('contactosDeTodasLasZonas', () => {
  it('trae las trece zonas, cada una con su propio resultado, en paralelo', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url: any, opciones: any) => {
      const cuerpo = JSON.parse(opciones.body);
      const zona = cuerpo.filters[0].value as string;
      if (zona === 'Guanacaste Interior') {
        return respuesta({ contacts: [{ id: 'c-1', email: 'a@x.cr' }] });
      }
      return respuesta({ contacts: [] });
    });
    const r = await contactosDeTodasLasZonas({ ...deps, fetchImpl });
    expect(Object.keys(r)).toHaveLength(13);
    expect(fetchImpl).toHaveBeenCalledTimes(13);
    expect(r['Guanacaste Interior']).toEqual({
      ok: true,
      contactos: [{ contactId: 'c-1', nombreCrm: '', correo: 'a@x.cr' }],
    });
    expect(r['GAM Oeste']).toEqual({ ok: true, contactos: [] });
  });

  it('el fallo de UNA zona queda en su propia entrada -- no tumba a las demás', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url: any, opciones: any) => {
      const cuerpo = JSON.parse(opciones.body);
      if (cuerpo.filters[0].value === 'Caribe') {
        return { ok: false, status: 500, text: async () => 'boom' } as unknown as Response;
      }
      return respuesta({ contacts: [] });
    });
    const r = await contactosDeTodasLasZonas({ ...deps, fetchImpl });
    expect(r['Caribe'].ok).toBe(false);
    expect(r['GAM Oeste']).toEqual({ ok: true, contactos: [] });
  });
});
