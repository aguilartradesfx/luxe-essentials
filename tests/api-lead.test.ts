import { describe, it, expect, vi, beforeEach } from 'vitest';

const insert = vi.fn();
const update = vi.fn();

// Controlables desde cada prueba: por defecto no fallan.
let erroActualizar: { message: string } | null = null;
let lanzarAlCrearCliente = false;

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
            select: () => ({ single: async () => ({ data: { id: 'fila-1' }, error: null }) }),
          };
        },
        update: (campos: unknown) => {
          update(campos);
          return { eq: async () => ({ error: erroActualizar }) };
        },
      }),
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

function peticion(body: unknown) {
  return new Request('http://localhost/api/lead', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  insert.mockClear();
  update.mockClear();
  upsertContact.mockReset();
  erroActualizar = null;
  lanzarAlCrearCliente = false;
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

  it('devuelve 500 en el shape del contrato si supabaseAdmin() lanza (p.ej. credenciales faltantes)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    lanzarAlCrearCliente = true;

    const res = await POST(peticion(cuerpo));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ ok: false, error: expect.any(String) });
    expect(upsertContact).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
