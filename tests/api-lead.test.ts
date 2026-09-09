import { describe, it, expect, vi, beforeEach } from 'vitest';

const insert = vi.fn();
const update = vi.fn();
const rpc = vi.fn();

// Controlables desde cada prueba: por defecto no fallan.
let erroActualizar: { message: string } | null = null;
let erroInsertar: { message: string } | null = null;
let lanzarAlCrearCliente = false;
// I9 (revision-final-2.md): por defecto la petición entra dentro del
// límite de tasa -- las pruebas de abuso, más abajo, lo pisan.
let permitidoLimite = true;
let erroLimite: { message: string } | null = null;

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => {
    if (lanzarAlCrearCliente) {
      throw new Error('Faltan las credenciales de Supabase en el servidor.');
    }
    return {
      from: () => ({
        insert: (fila: unknown) => {
          insert(fila);
          return {
            select: () => ({
              single: async () =>
                erroInsertar
                  ? { data: null, error: erroInsertar }
                  : { data: { id: 'fila-1' }, error: null },
            }),
          };
        },
        update: (campos: unknown) => {
          update(campos);
          return { eq: async () => ({ error: erroActualizar }) };
        },
      }),
      rpc: async (nombre: string, argumentos: Record<string, unknown>) => {
        rpc(nombre, argumentos);
        if (erroLimite) return { data: null, error: erroLimite };
        return { data: permitidoLimite, error: null };
      },
    };
  },
}));

const upsertContact = vi.fn();
vi.mock('@/lib/ghl', () => ({ upsertContact: (...a: unknown[]) => upsertContact(...a) }));

const { POST } = await import('@/app/api/lead/route');

const cuerpo = {
  nombre: 'Ana Pérez',
  email: 'ana@empresa.com',
  linea: 'uniformes',
};

function peticion(body: unknown, cabeceras: Record<string, string> = {}) {
  return new Request('http://localhost/api/lead', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cabeceras },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  insert.mockClear();
  update.mockClear();
  rpc.mockClear();
  upsertContact.mockReset();
  erroActualizar = null;
  erroInsertar = null;
  lanzarAlCrearCliente = false;
  permitidoLimite = true;
  erroLimite = null;
  process.env.LUXE_GHL_API_KEY = 'llave';
  process.env.LUXE_GHL_LOCATION_ID = 'ubicacion';
});

describe('POST /api/lead', () => {
  it('rechaza un cuerpo inválido con 400 y no toca la base', async () => {
    const res = await POST(peticion({ ...cuerpo, email: 'no-es-correo' }));
    expect(res.status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });

  it('guarda en Supabase antes de llamar a GHL', async () => {
    const orden: string[] = [];
    insert.mockImplementation(() => orden.push('supabase'));
    upsertContact.mockImplementation(async () => {
      orden.push('ghl');
      return { ok: true, contactId: 'c1' };
    });

    await POST(peticion(cuerpo));
    expect(orden).toEqual(['supabase', 'ghl']);
  });

  it('devuelve 201 y registra el id de GHL cuando todo sale bien', async () => {
    upsertContact.mockResolvedValue({ ok: true, contactId: 'c1' });
    const res = await POST(peticion(cuerpo));
    expect(res.status).toBe(201);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ ghl_contact_id: 'c1', ghl_error: null }),
    );
  });

  it('registra el fallo de la nota sin perder el id del contacto', async () => {
    upsertContact.mockResolvedValue({ ok: true, contactId: 'c1', notaError: 'GHL 422' });
    const res = await POST(peticion(cuerpo));

    expect(res.status).toBe(201);
    // El contacto existe: la fila no debe volver a la cola de reintento,
    // que filtra por `ghl_contact_id is null`.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ ghl_contact_id: 'c1', ghl_error: 'nota: GHL 422' }),
    );
  });

  it('sigue devolviendo 201 y anota el error cuando GHL falla', async () => {
    upsertContact.mockResolvedValue({ ok: false, error: 'GHL 401' });
    const res = await POST(peticion(cuerpo));

    expect(res.status).toBe(201);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ ghl_error: 'GHL 401' }));
  });

  it('cuerpo ilegible responde 400 con `errores` (mismo shape que la validación)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const peticionMalFormada = new Request('http://localhost/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{esto no es json',
    });

    const res = await POST(peticionMalFormada);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ ok: false, errores: {} });
    expect(insert).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('si Supabase no puede registrar un contacto ya creado en GHL, sigue devolviendo 201 y lo deja anotado en el log', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    erroActualizar = { message: 'timeout de red' };
    upsertContact.mockResolvedValue({ ok: true, contactId: 'c1' });

    const res = await POST(peticion(cuerpo));

    // El lead ya está a salvo en Supabase y el contacto ya existe en GHL:
    // el visitante no debe ver un error por un fallo de registro interno.
    expect(res.status).toBe(201);

    // Pero el fallo debe quedar anotado con el id de la fila y el id del
    // contacto de GHL: es el estado que un humano tiene que reconciliar a
    // mano (la fila quedó con `ghl_contact_id is null`, así que la cola de
    // reintento la recogería y crearía un contacto duplicado en el CRM).
    const mensajes = consoleErrorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(mensajes).toContain('fila-1');
    expect(mensajes).toContain('c1');

    consoleErrorSpy.mockRestore();
  });

  it('si el insert en Supabase falla, registra el correo, nombre y línea del lead antes de responder 500', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    erroInsertar = { message: 'JWT expired' };

    const res = await POST(peticion(cuerpo));

    // Éste es el único punto donde el lead se pierde sin fila ni id que
    // reconciliar: si no queda nada en el log, el nombre, correo y línea
    // del visitante desaparecen sin rastro.
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ ok: false, error: expect.any(String) });
    expect(upsertContact).not.toHaveBeenCalled();

    const mensajes = consoleErrorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(mensajes).toContain(cuerpo.email);
    expect(mensajes).toContain(cuerpo.nombre);
    expect(mensajes).toContain(cuerpo.linea);

    consoleErrorSpy.mockRestore();
  });

  it('devuelve 500 en el shape del contrato si supabaseAdmin() lanza (p.ej. credenciales faltantes)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    lanzarAlCrearCliente = true;

    const res = await POST(peticion(cuerpo));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ ok: false, error: expect.any(String) });
    expect(upsertContact).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  // I9 (revision-final-2.md): tres capas de control de abuso, ninguna debe
  // romper el camino feliz (ya cubierto arriba, sin ninguna cabecera
  // especial) ni las respuestas de error existentes.
  describe('honeypot', () => {
    it('si "paginaWeb" viene con contenido, responde éxito SIN tocar Supabase, GHL ni el límite de tasa', async () => {
      const res = await POST(peticion({ ...cuerpo, paginaWeb: 'https://spam.example' }));

      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toEqual({ ok: true });
      expect(insert).not.toHaveBeenCalled();
      expect(upsertContact).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    });

    it('con "paginaWeb" vacío (el caso normal de una persona real) sigue guardando el lead', async () => {
      upsertContact.mockResolvedValue({ ok: true, contactId: 'c1' });
      const res = await POST(peticion({ ...cuerpo, paginaWeb: '' }));
      expect(res.status).toBe(201);
      expect(insert).toHaveBeenCalled();
    });

    it('sin "paginaWeb" en el cuerpo (formularios que no lo mandan) sigue guardando el lead', async () => {
      upsertContact.mockResolvedValue({ ok: true, contactId: 'c1' });
      const res = await POST(peticion(cuerpo));
      expect(res.status).toBe(201);
      expect(insert).toHaveBeenCalled();
    });
  });

  describe('comprobación de origen', () => {
    it('sin cabecera Origin (la mayoría de los clientes de prueba y algunos navegadores viejos) deja pasar', async () => {
      upsertContact.mockResolvedValue({ ok: true, contactId: 'c1' });
      const res = await POST(peticion(cuerpo));
      expect(res.status).toBe(201);
      expect(insert).toHaveBeenCalled();
    });

    it('con Origin igual al host de la propia petición, deja pasar', async () => {
      upsertContact.mockResolvedValue({ ok: true, contactId: 'c1' });
      const res = await POST(
        peticion(cuerpo, { origin: 'http://localhost', host: 'localhost' }),
      );
      expect(res.status).toBe(201);
      expect(insert).toHaveBeenCalled();
    });

    it('con Origin de un sitio distinto, rechaza con 403 y no toca la base', async () => {
      const res = await POST(
        peticion(cuerpo, { origin: 'https://sitio-ajeno.example', host: 'localhost' }),
      );
      expect(res.status).toBe(403);
      expect(insert).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  describe('límite de tasa', () => {
    it('dentro del límite, deja pasar y guarda el lead', async () => {
      permitidoLimite = true;
      upsertContact.mockResolvedValue({ ok: true, contactId: 'c1' });
      const res = await POST(peticion(cuerpo));
      expect(res.status).toBe(201);
      expect(insert).toHaveBeenCalled();
    });

    it('fuera del límite, responde 429 y no toca Supabase ni GHL', async () => {
      permitidoLimite = false;
      const res = await POST(peticion(cuerpo));
      expect(res.status).toBe(429);
      expect(insert).not.toHaveBeenCalled();
      expect(upsertContact).not.toHaveBeenCalled();
    });

    it('llama al rpc con la IP de x-forwarded-for', async () => {
      upsertContact.mockResolvedValue({ ok: true, contactId: 'c1' });
      await POST(peticion(cuerpo, { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }));
      expect(rpc).toHaveBeenCalledWith(
        'lead_limite_tasa_incrementar',
        expect.objectContaining({ p_ip: '203.0.113.7' }),
      );
    });

    it('si la comprobación de la base falla, deja pasar (falla abierto) y sigue guardando el lead', async () => {
      erroLimite = { message: 'función inexistente' };
      upsertContact.mockResolvedValue({ ok: true, contactId: 'c1' });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await POST(peticion(cuerpo));

      expect(res.status).toBe(201);
      expect(insert).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });
});
