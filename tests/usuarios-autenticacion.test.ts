import { describe, it, expect, vi } from 'vitest';
import { hashClave } from '@/lib/cotizador/credenciales.mjs';
import { autenticarUsuario, MAX_INTENTOS, BLOQUEO_MINUTOS } from '@/lib/cotizador/usuarios';

// Doble de la parte de PostgREST que usa `autenticarUsuario`: una lectura por
// `lower(usuario)`, una escritura por id, y —desde la revisión final— la
// llamada `rpc` que cuenta los intentos fallidos. Guarda lo escrito y lo
// llamado para poder afirmar sobre ello.
//
// Revisión final, Importante 2: el conteo de intentos ya NO ocurre en
// JavaScript. Ocurre dentro de `public.usuarios_panel_intento_fallido`
// (supabase/migrations/0013_usuarios_panel_intento_fallido.sql), en una sola
// sentencia, porque el lee-modifica-escribe anterior se sorteaba con
// peticiones en paralelo. `rpc` de acá abajo es una reimplementación FIEL de
// esa función, y muta `fila` igual que la base mutaría el registro — así las
// pruebas de comportamiento de siempre (se cuenta el fallo, se bloquea al
// quinto, el contador vuelve a cero) siguen describiendo el mismo
// comportamiento de punta a punta.
//
// Lo que esa reimplementación NO puede probar es la aritmética del SQL en sí:
// si la migración divergiera de esta copia, estas pruebas seguirían en verde.
// Lo que sí queda anclado sobre el código de producción es el contrato —qué
// función se llama y con qué argumentos, y que no se emite ninguna escritura
// de contador por fuera—; ver el describe 'el contador es atómico', más abajo.
function db(
  fila: Record<string, unknown> | null,
  opciones: { errorDeEscritura?: string } = {},
) {
  const escrituras: Record<string, unknown>[] = [];
  const llamadasRpc: { nombre: string; argumentos: Record<string, unknown> }[] = [];
  const cliente = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: fila, error: null }),
        update(cambios: Record<string, unknown>) {
          escrituras.push(cambios);
          return {
            eq: async () => ({
              error: opciones.errorDeEscritura ? { message: opciones.errorDeEscritura } : null,
            }),
          };
        },
      };
    },
    async rpc(nombre: string, argumentos: Record<string, unknown>) {
      llamadasRpc.push({ nombre, argumentos });
      if (!fila || fila.id !== argumentos.p_id) return { data: false, error: null };

      const max = Number(argumentos.p_max_intentos);
      const minutos = Number(argumentos.p_bloqueo_minutos);
      const ahora = new Date(String(argumentos.p_ahora));
      const siguientes = Number(fila.intentos) + 1;

      if (siguientes >= max) {
        fila.intentos = 0;
        fila.bloqueado_hasta = new Date(ahora.getTime() + minutos * 60 * 1000).toISOString();
      } else {
        fila.intentos = siguientes;
      }

      const hasta = fila.bloqueado_hasta ? new Date(String(fila.bloqueado_hasta)) : null;
      return { data: hasta !== null && hasta.getTime() > ahora.getTime(), error: null };
    },
  };
  return { cliente: cliente as any, escrituras, llamadasRpc, fila };
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
    const { cliente, fila } = db(await filaDe('Turrialba-2026', { intentos: 2 }));
    await autenticarUsuario('guillermo', 'otra', cliente);
    expect(fila!.intentos).toBe(3);
  });

  it('bloquea al llegar al máximo de intentos', async () => {
    const ahora = new Date('2026-08-28T10:00:00Z');
    const { cliente, fila } = db(
      await filaDe('Turrialba-2026', { intentos: MAX_INTENTOS - 1 }),
    );
    const r = await autenticarUsuario('guillermo', 'otra', cliente, ahora);
    expect(r).toEqual({ ok: false, motivo: 'bloqueado' });
    expect(fila!.bloqueado_hasta).toBe('2026-08-28T10:15:00.000Z');
    // El contador vuelve a cero al bloquear: si no, el siguiente fallo tras
    // vencer el bloqueo volvería a bloquear de inmediato y la cuenta quedaría
    // atrapada en un ciclo del que sólo se sale por consola.
    expect(fila!.intentos).toBe(0);
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

  // Diferido T2, de la Tarea 2: "un fallo de escritura no lanza" no tenía
  // prueba — el doble siempre resolvía `update()` con `{ error: null }`, así
  // que si alguien hiciera que `escribir()` relanzara, ninguna prueba se
  // ponía roja. `escribir()` es lo único que anota el último acceso y lo que
  // reinicia el contador al entrar bien: si empezara a lanzar, `/entrar`
  // devolvería 500 en cada entrada CORRECTA, que es el peor momento posible
  // para fallar.
  it('si la escritura de la base falla, la entrada igual se concede', async () => {
    const ahora = new Date('2026-08-28T10:00:00Z');
    const { cliente, escrituras } = db(await filaDe('Turrialba-2026', { intentos: 3 }), {
      errorDeEscritura: 'no se pudo escribir',
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await autenticarUsuario('guillermo', 'Turrialba-2026', cliente, ahora);

    expect(r).toEqual({ ok: true, nombre: 'Guillermo Rojas' });
    // Se intentó anotar, y el fallo quedó registrado ruidosamente: la
    // anotación se pierde, pero no en silencio.
    expect(escrituras).toHaveLength(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // Revisión final, Importante 2. Estas cuatro pruebas son las que atan el
  // arreglo al código de producción: el conteo lo hace la base en una sola
  // sentencia, y no vuelve a haber un lee-modifica-escribe en JavaScript.
  describe('el contador es atómico: lo lleva la base, no la aplicación', () => {
    it('un fallo llama a la función de Postgres con los umbrales y el instante', async () => {
      const ahora = new Date('2026-08-28T10:00:00Z');
      const { cliente, llamadasRpc } = db(await filaDe('Turrialba-2026', { intentos: 2 }));
      await autenticarUsuario('guillermo', 'otra', cliente, ahora);

      expect(llamadasRpc).toHaveLength(1);
      expect(llamadasRpc[0].nombre).toBe('usuarios_panel_intento_fallido');
      expect(llamadasRpc[0].argumentos).toEqual({
        p_id: 'u1',
        p_max_intentos: MAX_INTENTOS,
        p_bloqueo_minutos: BLOQUEO_MINUTOS,
        p_ahora: '2026-08-28T10:00:00.000Z',
      });
    });

    // El ancla contra la regresión: si alguien devolviera el
    // lee-modifica-escribe (leer `fila.intentos`, sumar uno acá y escribir el
    // valor absoluto), aparecería un `update` con `intentos` en `escrituras` y
    // esta prueba se pondría roja. Sin ella, volver al código viejo pasaba en
    // verde mientras el doble siguiera respondiendo el `rpc`.
    it('un fallo no emite ninguna escritura del contador por fuera de la función', async () => {
      const { cliente, escrituras } = db(await filaDe('Turrialba-2026', { intentos: 2 }));
      await autenticarUsuario('guillermo', 'otra', cliente);
      expect(escrituras).toHaveLength(0);
    });

    // Los dos motivos siguen distinguiéndose, pero ahora quien los decide es
    // la base: la ruta relaya lo que la función devuelve. Se prueba con un
    // doble que responde a mano, sin pasar por la reimplementación de arriba.
    it('relaya el motivo que decide la base: true → bloqueado, false → credenciales', async () => {
      const fila = await filaDe('Turrialba-2026');
      const base = (respuesta: boolean) =>
        ({
          from: () => ({
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: fila, error: null }),
            update: () => ({ eq: async () => ({ error: null }) }),
          }),
          rpc: async () => ({ data: respuesta, error: null }),
        }) as any;

      expect(await autenticarUsuario('guillermo', 'mala', base(true))).toEqual({
        ok: false,
        motivo: 'bloqueado',
      });
      expect(await autenticarUsuario('guillermo', 'mala', base(false))).toEqual({
        ok: false,
        motivo: 'credenciales',
      });
    });

    // Si la base no puede contar el fallo, el rechazo sigue siendo un rechazo.
    // Convertirlo en un 500 le diría a quien prueba claves que acertó algo, y
    // dejaría al equipo sin poder entrar por un problema de contabilidad.
    it('si la función falla, el intento igual se rechaza como credenciales', async () => {
      const fila = await filaDe('Turrialba-2026');
      const cliente = {
        from: () => ({
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: fila, error: null }),
          update: () => ({ eq: async () => ({ error: null }) }),
        }),
        rpc: async () => ({ data: null, error: { message: 'función inexistente' } }),
      } as any;
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const r = await autenticarUsuario('guillermo', 'mala', cliente);

      expect(r).toEqual({ ok: false, motivo: 'credenciales' });
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
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
