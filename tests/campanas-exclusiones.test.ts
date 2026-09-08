// tests/campanas-exclusiones.test.ts
import { describe, it, expect, vi } from 'vitest';
import { registrarBaja, filtrarPermitidosParaCampana } from '@/lib/campanas/exclusiones';

// Doble mínimo de la tabla `bajas_correo`: `upsert` para `registrarBaja`,
// `select` para `filtrarPermitidosParaCampana`. Mismo patrón de
// `tests/panel-almacen.test.ts`: alcanza con lo que el módulo bajo prueba
// realmente llama, sin arrastrar el cliente completo de Supabase.
function dbConUpsert(resultado: unknown) {
  const upsert = vi.fn().mockResolvedValue(resultado);
  return { cliente: { from: () => ({ upsert }) }, upsert };
}

function dbConSelect(resultado: unknown) {
  const select = vi.fn().mockResolvedValue(resultado);
  return { cliente: { from: () => ({ select }) }, select };
}

describe('registrarBaja', () => {
  it('escribe el correo normalizado y la vía en bajas_correo', async () => {
    const db = dbConUpsert({ error: null });
    const r = await registrarBaja('  Ana@Hotel.com  ', 'pagina', db.cliente);
    expect(r).toEqual({ ok: true });
    expect(db.upsert).toHaveBeenCalledWith(
      { correo: 'ana@hotel.com', via: 'pagina' },
      { onConflict: 'correo', ignoreDuplicates: true },
    );
  });

  it('registra la vía "un_clic" tal cual se le pasa', async () => {
    const db = dbConUpsert({ error: null });
    await registrarBaja('ana@hotel.com', 'un_clic', db.cliente);
    expect(db.upsert).toHaveBeenCalledWith(
      { correo: 'ana@hotel.com', via: 'un_clic' },
      expect.anything(),
    );
  });

  // Idempotencia (Tarea 4): la MISMA llamada, dos veces, tiene que devolver
  // ok las dos veces y no reventar — es lo que `ignoreDuplicates: true` +
  // `onConflict: 'correo'` (el ON CONFLICT DO NOTHING real, resuelto por
  // Postgres contra el `unique` de la migración 0018) hace posible. El doble
  // de arriba ya simula que la segunda llamada no da error porque así se
  // comporta upsert con esas opciones contra la base real.
  it('darse de baja dos veces no falla (idempotente)', async () => {
    const db = dbConUpsert({ error: null });
    const primera = await registrarBaja('ana@hotel.com', 'pagina', db.cliente);
    const segunda = await registrarBaja('ana@hotel.com', 'un_clic', db.cliente);
    expect(primera).toEqual({ ok: true });
    expect(segunda).toEqual({ ok: true });
    expect(db.upsert).toHaveBeenCalledTimes(2);
  });

  it('sin correo, no llega a escribir nada', async () => {
    const db = dbConUpsert({ error: null });
    const r = await registrarBaja('   ', 'pagina', db.cliente);
    expect(r.ok).toBe(false);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('devuelve el error de Postgres sin lanzar', async () => {
    const db = dbConUpsert({ error: { message: 'constraint violada' } });
    const r = await registrarBaja('ana@hotel.com', 'pagina', db.cliente);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('constraint violada') });
  });

  it('no lanza si la base explota', async () => {
    const cliente = { from: () => { throw new Error('sin red'); } };
    const r = await registrarBaja('ana@hotel.com', 'pagina', cliente);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('sin red') });
  });
});

describe('filtrarPermitidosParaCampana', () => {
  it('deja pasar a quien no está en bajas_correo', async () => {
    const db = dbConSelect({ data: [], error: null });
    const r = await filtrarPermitidosParaCampana([{ correo: 'ana@hotel.com' }], db.cliente);
    expect(r).toEqual([{ correo: 'ana@hotel.com' }]);
  });

  it('excluye a quien SÍ está en bajas_correo', async () => {
    const db = dbConSelect({ data: [{ correo: 'baja@hotel.com' }], error: null });
    const r = await filtrarPermitidosParaCampana(
      [{ correo: 'ana@hotel.com' }, { correo: 'baja@hotel.com' }],
      db.cliente,
    );
    expect(r).toEqual([{ correo: 'ana@hotel.com' }]);
  });

  // Mata el mutante que compara los correos sin normalizar: una baja
  // guardada en minúsculas (siempre lo está, ver registrarBaja) tiene que
  // excluir igual a un destinatario cuyo correo llega con otra
  // capitalización o con espacios — el mismo contacto, dos formas de
  // escribir el mismo correo.
  it('excluye aunque el correo del destinatario llegue con otra capitalización', async () => {
    const db = dbConSelect({ data: [{ correo: 'baja@hotel.com' }], error: null });
    const r = await filtrarPermitidosParaCampana([{ correo: '  Baja@Hotel.com  ' }], db.cliente);
    expect(r).toEqual([]);
  });

  it('con la lista de destinatarios vacía, devuelve una lista vacía sin consultar la base', async () => {
    const db = dbConSelect({ data: [], error: null });
    const r = await filtrarPermitidosParaCampana([], db.cliente);
    expect(r).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('conserva el resto de los campos de cada destinatario, no sólo el correo', async () => {
    const db = dbConSelect({ data: [], error: null });
    const r = await filtrarPermitidosParaCampana(
      [{ correo: 'ana@hotel.com', nombre: 'Ana', id: 'c-1' }],
      db.cliente,
    );
    expect(r).toEqual([{ correo: 'ana@hotel.com', nombre: 'Ana', id: 'c-1' }]);
  });

  // Fail-closed (Tarea 5): si no se puede leer la lista de bajas, NUNCA se
  // devuelve "todos permitidos" ni una lista vacía interpretable como "nadie
  // está de baja" — se lanza, para que un envío de campaña no pueda seguir
  // adelante creyendo que ya filtró cuando en realidad no pudo comprobar
  // nada.
  it('si no se puede leer bajas_correo, lanza en vez de dejar pasar a todos', async () => {
    const db = dbConSelect({ data: null, error: { message: 'timeout' } });
    await expect(
      filtrarPermitidosParaCampana([{ correo: 'ana@hotel.com' }], db.cliente),
    ).rejects.toThrow(/timeout/);
  });
});
