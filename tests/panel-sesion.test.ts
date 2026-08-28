// tests/panel-sesion.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { emitirSesion, sesionValida, csrfValido } from '@/lib/sesion';

function conCookie(valor: string, cabeceras: Record<string, string> = {}) {
  return new Request('http://localhost/x', { headers: { cookie: valor, ...cabeceras } });
}

describe('sesión', () => {
  beforeEach(() => {
    process.env.LUXE_TALLER_CLAVE = 'secreta';
  });

  it('la cookie es httpOnly, secure y sameSite=none', () => {
    const { cookie } = emitirSesion();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toMatch(/SameSite=None/i);
  });

  it('dura 30 días', () => {
    const { cookie } = emitirSesion();
    expect(cookie).toMatch(/Max-Age=2592000/);
  });

  it('acepta una sesión que ella misma emitió', () => {
    const { cookie } = emitirSesion();
    const valor = cookie.split(';')[0];
    expect(sesionValida(conCookie(valor))).toBe(true);
  });

  it('rechaza una cookie inventada', () => {
    expect(sesionValida(conCookie('luxe_sesion=inventado'))).toBe(false);
  });

  it('rechaza si no hay cookie', () => {
    expect(sesionValida(new Request('http://localhost/x'))).toBe(false);
  });

  it('rechaza una sesión firmada con otra clave', () => {
    const { cookie } = emitirSesion();
    const valor = cookie.split(';')[0];
    process.env.LUXE_TALLER_CLAVE = 'otra';
    expect(sesionValida(conCookie(valor))).toBe(false);
  });

  it('el token anti-CSRF debe coincidir con el de la sesión', () => {
    const { cookie, csrf } = emitirSesion();
    const valor = cookie.split(';')[0];
    expect(csrfValido(conCookie(valor), csrf)).toBe(true);
    expect(csrfValido(conCookie(valor), 'otro')).toBe(false);
    expect(csrfValido(conCookie(valor), undefined)).toBe(false);
  });
});
