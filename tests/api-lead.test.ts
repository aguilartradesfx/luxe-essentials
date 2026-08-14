import { describe, it, expect, vi, beforeEach } from 'vitest';

const insert = vi.fn();
const update = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: (fila: unknown) => {
        insert(fila);
        return { select: () => ({ single: async () => ({ data: { id: 'fila-1' }, error: null }) }) };
      },
      update: (campos: unknown) => {
        update(campos);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
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
});
