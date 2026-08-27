import { describe, it, expect, vi } from 'vitest';
import { registrarIntencion } from '@/lib/cotizador/borrador';
import { DATOS_VACIOS } from '@/lib/agente/estado';

function db(filas: unknown[] = []) {
  const insertados: unknown[] = [];
  return {
    insertados,
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ limit: async () => ({ data: filas, error: null }) }) }),
      }),
      insert: async (fila: unknown) => {
        insertados.push(fila);
        return { error: null };
      },
    }),
  };
}

const completos = {
  ...DATOS_VACIOS,
  nombre: 'Ana Pérez', email: 'ana@hotel.com',
  producto: 'uniformes' as const, cantidad: '300 piezas',
};

describe('registrarIntencion', () => {
  it('inserta el borrador cuando hay correo, producto y cantidad', async () => {
    const base = db();
    const error = await registrarIntencion({ contactId: 'c1', datos: completos }, base);
    expect(error).toBeUndefined();
    expect(base.insertados).toHaveLength(1);
    const fila = base.insertados[0] as Record<string, unknown>;
    expect(fila.origen).toBe('agente');
    expect(fila.estado).toBe('borrador');
    expect(fila.contact_id).toBe('c1');
    expect(fila.lineas).toEqual([]);
  });

  it('guarda la cantidad tal como la dijo el cliente', async () => {
    const base = db();
    await registrarIntencion({ contactId: 'c1', datos: completos }, base);
    const fila = base.insertados[0] as { cliente: Record<string, unknown> };
    expect(fila.cliente.cantidadTexto).toBe('300 piezas');
    expect(fila.cliente.producto).toBe('uniformes');
  });

  it('no inserta si falta la cantidad', async () => {
    const base = db();
    await registrarIntencion({ contactId: 'c1', datos: { ...completos, cantidad: null } }, base);
    expect(base.insertados).toHaveLength(0);
  });

  it('no inserta si falta el correo', async () => {
    const base = db();
    await registrarIntencion({ contactId: 'c1', datos: { ...completos, email: null } }, base);
    expect(base.insertados).toHaveLength(0);
  });

  it('no duplica si el contacto ya tiene un borrador abierto', async () => {
    const base = db([{ id: 'ya-existe' }]);
    await registrarIntencion({ contactId: 'c1', datos: completos }, base);
    expect(base.insertados).toHaveLength(0);
  });

  it('devuelve el error de base sin lanzar', async () => {
    const roto = {
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: 'sin conexión' } }) }) }),
        }),
      }),
    };
    const error = await registrarIntencion({ contactId: 'c1', datos: completos }, roto);
    expect(error).toContain('sin conexión');
  });
});
