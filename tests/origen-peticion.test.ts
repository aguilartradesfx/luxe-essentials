import { describe, it, expect } from 'vitest';
import { origenValido } from '@/lib/origen-peticion';

// I9 (revision-final-2.md): /api/lead es pública, sin sesión ni clave que
// revisar. Esta comprobación es la primera de las tres capas baratas.
function peticion(cabeceras: Record<string, string> = {}) {
  return new Request('http://da-igual/lo-que-sea', { method: 'POST', headers: cabeceras });
}

describe('origenValido', () => {
  it('sin cabecera Origin, deja pasar (no se puede comprobar lo que no vino)', () => {
    expect(origenValido(peticion())).toBe(true);
    expect(origenValido(peticion({ host: 'luxeessentialscr.com' }))).toBe(true);
  });

  it('con Origin y Host iguales, deja pasar', () => {
    expect(
      origenValido(peticion({ origin: 'https://luxeessentialscr.com', host: 'luxeessentialscr.com' })),
    ).toBe(true);
  });

  it('con Origin y Host iguales pero con puerto (deploy local), deja pasar', () => {
    expect(origenValido(peticion({ origin: 'http://localhost:3000', host: 'localhost:3000' }))).toBe(true);
  });

  it('con Origin de un sitio distinto, rechaza', () => {
    expect(
      origenValido(peticion({ origin: 'https://sitio-ajeno.example', host: 'luxeessentialscr.com' })),
    ).toBe(false);
  });

  it('con Origin igual en el nombre de dominio pero puerto distinto, rechaza (el host completo debe calzar)', () => {
    expect(
      origenValido(peticion({ origin: 'http://localhost:4000', host: 'localhost:3000' })),
    ).toBe(false);
  });

  it('con Origin que no es una URL válida, rechaza en vez de confiar en un valor roto', () => {
    expect(origenValido(peticion({ origin: 'no-es-una-url', host: 'luxeessentialscr.com' }))).toBe(false);
  });

  it('sin cabecera Host mientras Origin sí vino, rechaza (nada contra qué comparar)', () => {
    expect(origenValido(peticion({ origin: 'https://luxeessentialscr.com' }))).toBe(false);
  });
});
