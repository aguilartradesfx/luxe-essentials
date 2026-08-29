import { describe, it, expect } from 'vitest';
import { hashClave } from '@/lib/cotizador/credenciales.mjs';
import { autenticarUsuario, MAX_INTENTOS } from '@/lib/cotizador/usuarios';

// Doble de la parte de PostgREST que usa `autenticarUsuario`: una lectura por
// `lower(usuario)` y una escritura por id. Guarda lo escrito para poder
// afirmar sobre ello — que es donde viven los intentos y el bloqueo.
function db(fila: Record<string, unknown> | null) {
  const escrituras: Record<string, unknown>[] = [];
  const cliente = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: fila, error: null }),
        update(cambios: Record<string, unknown>) {
          escrituras.push(cambios);
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };
  return { cliente: cliente as any, escrituras };
}

async function filaDe(clave: string, extra: Record<string, unknown> = {}) {
  const { hash, sal } = await hashClave(clave);
  return {
    id: 'u1', usuario: 'guillermo', nombre: 'Guillermo Rojas',
    clave_hash: hash, clave_sal: sal,
    activo: true, intentos: 0, bloqueado_hasta: null,
    ...extra,
  };
}

describe('autenticarUsuario', () => {
  it('devuelve el nombre con la clave correcta', async () => {
    const { cliente } = db(await filaDe('Turrialba-2026'));
    const r = await autenticarUsuario('guillermo', 'Turrialba-2026', cliente);
    expect(r).toEqual({ ok: true, nombre: 'Guillermo Rojas' });
  });

  it('normaliza el usuario: mayúsculas y espacios no impiden entrar', async () => {
    const { cliente } = db(await filaDe('Turrialba-2026'));
    const r = await autenticarUsuario('  GUILLERMO ', 'Turrialba-2026', cliente);
    expect(r.ok).toBe(true);
  });

  it('rechaza la clave incorrecta', async () => {
    const { cliente } = db(await filaDe('Turrialba-2026'));
    const r = await autenticarUsuario('guillermo', 'otra', cliente);
    expect(r).toEqual({ ok: false, motivo: 'credenciales' });
  });

  it('rechaza a un usuario que no existe, con el mismo motivo', async () => {
    const { cliente } = db(null);
    const r = await autenticarUsuario('nadie', 'x', cliente);
    expect(r).toEqual({ ok: false, motivo: 'credenciales' });
  });

  it('rechaza a un usuario desactivado aunque la clave sea correcta', async () => {
    const { cliente } = db(await filaDe('Turrialba-2026', { activo: false }));
    const r = await autenticarUsuario('guillermo', 'Turrialba-2026', cliente);
    expect(r).toEqual({ ok: false, motivo: 'credenciales' });
  });

  it('cuenta el intento fallido', async () => {
    const { cliente, escrituras } = db(await filaDe('Turrialba-2026', { intentos: 2 }));
    await autenticarUsuario('guillermo', 'otra', cliente);
    expect(escrituras[0].intentos).toBe(3);
  });

  it('bloquea al llegar al máximo de intentos', async () => {
    const ahora = new Date('2026-08-28T10:00:00Z');
    const { cliente, escrituras } = db(
      await filaDe('Turrialba-2026', { intentos: MAX_INTENTOS - 1 }),
    );
    const r = await autenticarUsuario('guillermo', 'otra', cliente, ahora);
    expect(r).toEqual({ ok: false, motivo: 'bloqueado' });
    expect(escrituras[0].bloqueado_hasta).toBe('2026-08-28T10:15:00.000Z');
    // El contador vuelve a cero al bloquear: si no, el siguiente fallo tras
    // vencer el bloqueo volvería a bloquear de inmediato y la cuenta quedaría
    // atrapada en un ciclo del que sólo se sale por consola.
    expect(escrituras[0].intentos).toBe(0);
  });

  it('rechaza mientras el bloqueo sigue vigente, aun con la clave correcta', async () => {
    const ahora = new Date('2026-08-28T10:00:00Z');
    const fila = await filaDe('Turrialba-2026', {
      bloqueado_hasta: '2026-08-28T10:10:00.000Z',
    });
    const { cliente } = db(fila);
    const r = await autenticarUsuario('guillermo', 'Turrialba-2026', cliente, ahora);
    expect(r).toEqual({ ok: false, motivo: 'bloqueado' });
  });

  it('deja entrar cuando el bloqueo ya venció', async () => {
    const ahora = new Date('2026-08-28T10:20:00Z');
    const fila = await filaDe('Turrialba-2026', {
      bloqueado_hasta: '2026-08-28T10:10:00.000Z',
    });
    const { cliente } = db(fila);
    const r = await autenticarUsuario('guillermo', 'Turrialba-2026', cliente, ahora);
    expect(r.ok).toBe(true);
  });

  it('al entrar bien, reinicia los intentos y levanta el bloqueo', async () => {
    const ahora = new Date('2026-08-28T10:00:00Z');
    const { cliente, escrituras } = db(await filaDe('Turrialba-2026', { intentos: 3 }));
    await autenticarUsuario('guillermo', 'Turrialba-2026', cliente, ahora);
    expect(escrituras[0]).toMatchObject({
      intentos: 0,
      bloqueado_hasta: null,
      ultimo_acceso: '2026-08-28T10:00:00.000Z',
    });
  });

  // Un fallo de lectura no puede confundirse con "credenciales malas": eso
  // dejaría al equipo afuera con un mensaje que culpa a su clave, y el problema
  // real (la base caída) no aparecería en ningún lado.
  it('lanza si la lectura de la base falla', async () => {
    const cliente = {
      from: () => ({
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: null, error: { message: 'conexión caída' } }),
      }),
    } as any;
    await expect(autenticarUsuario('guillermo', 'x', cliente)).rejects.toThrow(/conexión caída/);
  });
});
