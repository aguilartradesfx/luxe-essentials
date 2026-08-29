import { describe, it, expect } from 'vitest';
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

  it('devuelve hash y sal en hexadecimal, con los tamaños esperados', async () => {
    const { hash, sal } = await hashClave('Turrialba-2026');
    expect(sal).toMatch(/^[0-9a-f]{32}$/);   // 16 bytes
    expect(hash).toMatch(/^[0-9a-f]{128}$/); // 64 bytes
  });

  // Una fila corrupta o truncada no puede tumbar el endpoint de entrada: eso
  // convertiría un dato malo en una caída, no en un rechazo.
  it('devuelve false ante hash o sal mal formados, sin lanzar', async () => {
    expect(await verificarClave('x', 'no-es-hex', 'tampoco')).toBe(false);
    expect(await verificarClave('x', '', '')).toBe(false);
    expect(await verificarClave('x', 'ab', 'cd')).toBe(false);
  });

  // Una clave vacía guardada por error dejaría una puerta abierta.
  it('no permite derivar un hash de una clave vacía', async () => {
    await expect(hashClave('')).rejects.toThrow();
  });
});
