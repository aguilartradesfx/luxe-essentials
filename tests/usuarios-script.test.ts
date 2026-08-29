import { describe, it, expect, vi } from 'vitest';
import { construirSql, completarArgumentos } from '../scripts/usuarios.mjs';
import { verificarClave } from '@/lib/cotizador/credenciales.mjs';

describe('construirSql', () => {
  it('arma el alta con parámetros, nunca por interpolación', async () => {
    const { texto, valores } = await construirSql('alta', ['Guillermo', 'Guillermo Rojas', 'Turrialba-2026']);
    expect(texto).toContain('insert into public.usuarios_panel');
    // Ni el nombre ni la clave pueden aparecer en el texto de la consulta: si
    // aparecieran, una comilla en un apellido rompería el SQL —y el mismo
    // agujero serviría para inyectarlo.
    expect(texto).not.toContain('Guillermo');
    expect(texto).not.toContain('Turrialba-2026');
    expect(valores).toContain('guillermo');       // usuario normalizado
    expect(valores).toContain('Guillermo Rojas'); // nombre tal cual
  });

  it('el hash que guarda el alta verifica con la clave dada', async () => {
    const { valores } = await construirSql('alta', ['guillermo', 'Guillermo Rojas', 'Turrialba-2026']);
    const [, , hash, sal] = valores;
    expect(await verificarClave('Turrialba-2026', hash, sal)).toBe(true);
  });

  it('desactivar y activar nunca borran la fila, sólo cambian activo', async () => {
    const { texto: textoDesactivar } = await construirSql('desactivar', ['guillermo']);
    expect(textoDesactivar).toContain('update');
    expect(textoDesactivar).toContain('activo = false');
    expect(textoDesactivar).not.toMatch(/\bdelete\b/i);

    const { texto: textoActivar } = await construirSql('activar', ['guillermo']);
    expect(textoActivar).toContain('update');
    expect(textoActivar).toContain('activo = true');
    expect(textoActivar).not.toMatch(/\bdelete\b/i);
  });

  it('desbloquear limpia el bloqueo y el contador', async () => {
    const { texto } = await construirSql('desbloquear', ['guillermo']);
    expect(texto).toContain('bloqueado_hasta = null');
    expect(texto).toContain('intentos = 0');
  });

  it('clave deriva un hash nuevo que verifica, y de paso desbloquea la cuenta', async () => {
    const { texto, valores } = await construirSql('clave', ['guillermo', 'Turrialba-2027']);
    // Quien cambia la clave de alguien es porque esa persona no puede entrar:
    // si el cambio no limpia el bloqueo y el contador, la orden no sirve para
    // lo único que se usa.
    expect(texto).toContain('bloqueado_hasta = null');
    expect(texto).toContain('intentos = 0');
    const [hash, sal] = valores;
    expect(await verificarClave('Turrialba-2027', hash, sal)).toBe(true);
  });

  // La lista es para saber quién tiene acceso, no para exfiltrar hashes.
  it('listar no selecciona el hash ni la sal', async () => {
    const { texto } = await construirSql('listar', []);
    expect(texto).not.toContain('clave_hash');
    expect(texto).not.toContain('clave_sal');
  });

  it('rechaza una orden desconocida', async () => {
    await expect(construirSql('borrar-todo', [])).rejects.toThrow();
  });

  it('exige los argumentos de cada orden', async () => {
    await expect(construirSql('alta', ['guillermo'])).rejects.toThrow();
    await expect(construirSql('desactivar', [])).rejects.toThrow();
  });
});

// Revisión final, M2: pasar la clave como argumento la deja en
// `~/.zsh_history` y visible en `ps` mientras el comando corre. La forma con
// argumento se conserva (la usan las pruebas de arriba, y sirve para
// automatizar), pero la recomendada es la interactiva.
describe('completarArgumentos', () => {
  it('pide la clave del alta por consola cuando no viene como argumento', async () => {
    const pedir = vi.fn().mockResolvedValue('Turrialba-2026');
    const completos = await completarArgumentos('alta', ['guillermo', 'Guillermo Rojas'], pedir);

    expect(completos).toEqual(['guillermo', 'Guillermo Rojas', 'Turrialba-2026']);
    // Dos veces: sin eco, una clave mal tecleada no se ve, y el síntoma llega
    // días después como "no puedo entrar" de alguien que sí la escribió bien.
    expect(pedir).toHaveBeenCalledTimes(2);
  });

  it('pide la clave nueva de `clave` por consola cuando no viene como argumento', async () => {
    const pedir = vi.fn().mockResolvedValue('Turrialba-2027');
    const completos = await completarArgumentos('clave', ['guillermo'], pedir);
    expect(completos).toEqual(['guillermo', 'Turrialba-2027']);
  });

  it('no pregunta nada si la clave sí vino como argumento', async () => {
    const pedir = vi.fn();
    const completos = await completarArgumentos('alta', ['guillermo', 'G R', 'ya-la-tengo'], pedir);
    expect(completos).toEqual(['guillermo', 'G R', 'ya-la-tengo']);
    expect(pedir).not.toHaveBeenCalled();
  });

  it('no pregunta nada en las órdenes que no llevan clave', async () => {
    const pedir = vi.fn();
    for (const orden of ['listar', 'desactivar', 'activar', 'desbloquear']) {
      await completarArgumentos(orden, ['guillermo'], pedir);
    }
    expect(pedir).not.toHaveBeenCalled();
  });

  it('rechaza si las dos veces no coinciden, sin tocar nada', async () => {
    const pedir = vi.fn().mockResolvedValueOnce('una').mockResolvedValueOnce('otra');
    await expect(
      completarArgumentos('alta', ['guillermo', 'Guillermo Rojas'], pedir),
    ).rejects.toThrow(/no coinciden/i);
  });

  it('rechaza una clave vacía sin llegar a preguntar la segunda vez', async () => {
    const pedir = vi.fn().mockResolvedValue('');
    await expect(
      completarArgumentos('alta', ['guillermo', 'Guillermo Rojas'], pedir),
    ).rejects.toThrow(/vacía/i);
    expect(pedir).toHaveBeenCalledTimes(1);
  });

  // Si faltan los argumentos previos, la orden va a fallar igual: preguntar
  // una clave antes de eso haría teclear un secreto para nada.
  it('no pregunta si faltan los argumentos anteriores a la clave', async () => {
    const pedir = vi.fn();
    await completarArgumentos('alta', ['guillermo'], pedir);
    expect(pedir).not.toHaveBeenCalled();
  });
});
