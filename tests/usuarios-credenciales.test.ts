import { describe, it, expect } from 'vitest';
import { scryptSync } from 'node:crypto';
import { hashClave, verificarClave } from '@/lib/cotizador/credenciales.mjs';

describe('credenciales', () => {
  it('acepta la clave correcta', async () => {
    const { hash, sal } = await hashClave('Turrialba-2026');
    expect(await verificarClave('Turrialba-2026', hash, sal)).toBe(true);
  });

  it('rechaza una clave distinta', async () => {
    const { hash, sal } = await hashClave('Turrialba-2026');
    expect(await verificarClave('turrialba-2026', hash, sal)).toBe(false);
  });

  // Sin sal por usuario, dos vendedores con la misma clave tendrían el mismo
  // hash: quien viera la tabla sabría que coinciden, y una tabla precalculada
  // serviría para todos a la vez.
  it('produce hashes distintos para la misma clave', async () => {
    const a = await hashClave('Turrialba-2026');
    const b = await hashClave('Turrialba-2026');
    expect(a.sal).not.toBe(b.sal);
    expect(a.hash).not.toBe(b.hash);
  });

  it('devuelve la sal en hexadecimal y el hash con sus parámetros incrustados', async () => {
    const { hash, sal } = await hashClave('Turrialba-2026');
    expect(sal).toMatch(/^[0-9a-f]{32}$/); // 16 bytes
    // `scrypt$N$r$p$<hex de 64 bytes>`. Ver el describe de abajo para por qué
    // los parámetros van pegados al hash y no sueltos en el módulo.
    expect(hash).toMatch(/^scrypt\$65536\$8\$1\$[0-9a-f]{128}$/);
  });

  // Una fila corrupta o truncada no puede tumbar el endpoint de entrada: eso
  // convertiría un dato malo en una caída, no en un rechazo.
  it('devuelve false ante hash o sal mal formados, sin lanzar', async () => {
    expect(await verificarClave('x', 'no-es-hex', 'tampoco')).toBe(false);
    expect(await verificarClave('x', '', '')).toBe(false);
    expect(await verificarClave('x', 'ab', 'cd')).toBe(false);
    // Un hash con la forma correcta pero la sal mal.
    const { hash } = await hashClave('Turrialba-2026');
    expect(await verificarClave('Turrialba-2026', hash, 'no-es-hex')).toBe(false);
    // Un hash hexadecimal pelado, del formato anterior a la revisión final:
    // sin parámetros no se sabe con qué derivarlo, así que no verifica.
    expect(await verificarClave('Turrialba-2026', 'a'.repeat(128), 'b'.repeat(32))).toBe(false);
  });

  // Revisión final, M1: los parámetros eran constantes del módulo y NO se
  // guardaban con el hash. El día que alguien subiera `N`, todos los hashes ya
  // escritos dejaban de verificar en silencio, y el síntoma era "a todo el
  // mundo le dejó de servir la clave" sin ninguna pista del porqué. La tabla
  // tenía cero filas, así que arreglarlo salía gratis; después no.
  describe('los parámetros viajan con cada hash', () => {
    it('deriva los hashes nuevos con N=2^16', async () => {
      const { hash } = await hashClave('Turrialba-2026');
      const [, n, r, p] = hash.split('$');
      expect(Number(n)).toBe(2 ** 16);
      expect(Number(r)).toBe(8);
      expect(Number(p)).toBe(1);
    });

    // La prueba que justifica el formato entero: un hash derivado con los
    // parámetros VIEJOS sigue verificando, aunque el módulo ya use otros. Sin
    // los parámetros incrustados, esto daría `false` — que es exactamente el
    // fallo silencioso que se quería evitar.
    it('verifica un hash derivado con parámetros distintos de los de hoy', async () => {
      const { hash, sal } = await hashClave('Turrialba-2026');
      const hex = hash.split('$')[4];
      // Se deriva a mano con los parámetros de la versión anterior (N=2^14) y
      // se arma un hash que los declara.
      const viejo = scryptSync('Turrialba-2026', Buffer.from(sal, 'hex'), 64, {
        N: 2 ** 14,
        r: 8,
        p: 1,
      }).toString('hex');
      // Control: los dos hex son distintos, así que la prueba no pasa por
      // casualidad al derivar lo mismo dos veces.
      expect(viejo).not.toBe(hex);

      expect(await verificarClave('Turrialba-2026', `scrypt$16384$8$1$${viejo}`, sal)).toBe(true);
      expect(await verificarClave('otra', `scrypt$16384$8$1$${viejo}`, sal)).toBe(false);
    });

    // Los parámetros llegan desde una fila de la base. Sin cotas, una fila
    // corrupta —o escrita por quien tenga acceso a la tabla— con un `N`
    // enorme convertiría cada intento de entrada en una petición que reserva
    // gigabytes de memoria.
    it('rechaza parámetros fuera de rango en vez de intentar derivarlos', async () => {
      const { sal } = await hashClave('Turrialba-2026');
      const hex = 'a'.repeat(128);
      expect(await verificarClave('x', `scrypt$1073741824$8$1$${hex}`, sal)).toBe(false); // N gigante
      expect(await verificarClave('x', `scrypt$1024$8$1$${hex}`, sal)).toBe(false); // N por debajo del mínimo
      expect(await verificarClave('x', `scrypt$65535$8$1$${hex}`, sal)).toBe(false); // N no es potencia de dos
      expect(await verificarClave('x', `scrypt$65536$999$1$${hex}`, sal)).toBe(false); // r fuera de rango
      expect(await verificarClave('x', `scrypt$65536$8$999$${hex}`, sal)).toBe(false); // p fuera de rango
      expect(await verificarClave('x', `bcrypt$65536$8$1$${hex}`, sal)).toBe(false); // otro algoritmo
    });
  });

  // Una clave vacía guardada por error dejaría una puerta abierta.
  it('no permite derivar un hash de una clave vacía', async () => {
    await expect(hashClave('')).rejects.toThrow();
  });
});
