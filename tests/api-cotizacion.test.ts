import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertado: unknown[] = [];
vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: (fila: unknown) => {
        insertado.push(fila);
        return {
          select: () => ({
            single: async () => ({ data: { id: 'cot-1', ...(fila as object) }, error: null }),
          }),
        };
      },
    }),
  }),
}));

const { POST } = await import('@/app/api/cotizacion/route');

function peticion(cuerpo: unknown) {
  return new Request('http://localhost/api/cotizacion', {
    method: 'POST',
    body: JSON.stringify(cuerpo),
  });
}

const valido = {
  clave: 'secreta',
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
  lineas: [{ skuId: 'set-600-king', cantidad: 16 }],
};

describe('POST /api/cotizacion', () => {
  beforeEach(() => {
    insertado.length = 0;
    process.env.LUXE_TALLER_CLAVE = 'secreta';
  });

  it('rechaza sin clave', async () => {
    const res = await POST(peticion({ ...valido, clave: 'otra' }));
    expect(res.status).toBe(401);
  });

  it('rechaza un cuerpo que no es JSON', async () => {
    const res = await POST(
      new Request('http://localhost/api/cotizacion', { method: 'POST', body: 'no soy json' }),
    );
    expect(res.status).toBe(400);
  });

  it('rechaza un correo inválido', async () => {
    const res = await POST(peticion({ ...valido, cliente: { ...valido.cliente, email: 'roto' } }));
    expect(res.status).toBe(400);
  });

  it('rechaza una cotización sin líneas', async () => {
    const res = await POST(peticion({ ...valido, lineas: [] }));
    expect(res.status).toBe(400);
  });

  it('rechaza un sku que no existe', async () => {
    const res = await POST(peticion({ ...valido, lineas: [{ skuId: 'fantasma', cantidad: 1 }] }));
    expect(res.status).toBe(400);
  });

  it('devuelve el cálculo y guarda la fila', async () => {
    const res = await POST(peticion(valido));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.cotizacion.lineas[0].descuentoPct).toBe(10);
    expect(insertado).toHaveLength(1);
  });

  it('acepta una tasa de IVA distinta', async () => {
    const res = await POST(peticion({ ...valido, tasaIva: 0.01 }));
    const cuerpo = await res.json();
    expect(cuerpo.cotizacion.tasaIva).toBe(0.01);
  });
});
