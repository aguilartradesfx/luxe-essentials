import { describe, it, expect } from 'vitest';
import { construirSql } from '../scripts/usuarios.mjs';
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

  it('desactivar no borra la fila', async () => {
    const { texto } = await construirSql('desactivar', ['guillermo']);
    expect(texto).toContain('update');
    expect(texto).not.toMatch(/\bdelete\b/i);
  });

  it('desbloquear limpia el bloqueo y el contador', async () => {
    const { texto } = await construirSql('desbloquear', ['guillermo']);
    expect(texto).toContain('bloqueado_hasta = null');
    expect(texto).toContain('intentos = 0');
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
