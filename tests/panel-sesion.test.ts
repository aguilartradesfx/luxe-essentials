// tests/panel-sesion.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  it('la cookie lleva Partitioned (CHIPS): sin esto es de terceros dentro del iframe y Safari/Chrome pueden bloquearla', () => {
    const { cookie } = emitirSesion();
    expect(cookie).toMatch(/Partitioned/i);
  });

  // --- Ronda de correcciones 1 (hallazgo crítico): la sesión nunca caducaba.
  // `sesionValida` verificaba la firma pero no comparaba `emitidoEn` contra
  // la hora actual, así que una cookie firmada hace 100 días —o con fecha en
  // el año 3000— validaba igual. Con estas dos pruebas, revertir el chequeo
  // de caducidad las pone en rojo.

  describe('caducidad', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('rechaza una sesión firmada hace más de 30 días', () => {
      vi.useFakeTimers();
      const { cookie } = emitirSesion();
      const valor = cookie.split(';')[0];
      // 30 días + 1 segundo: justo pasado el borde de Max-Age.
      vi.advanceTimersByTime(2592000 * 1000 + 1000);
      expect(sesionValida(conCookie(valor))).toBe(false);
    });

    it('acepta una sesión firmada hace 29 días (dentro de los 30)', () => {
      vi.useFakeTimers();
      const { cookie } = emitirSesion();
      const valor = cookie.split(';')[0];
      vi.advanceTimersByTime(29 * 24 * 60 * 60 * 1000);
      expect(sesionValida(conCookie(valor))).toBe(true);
    });

    it('rechaza una sesión con fecha de emisión en el futuro (reloj adelantado o cookie forjada)', () => {
      vi.useFakeTimers();
      const ahoraReal = Date.now();
      vi.setSystemTime(ahoraReal + 60 * 60 * 1000); // "ahora" adelantado 1 hora.
      const { cookie } = emitirSesion();
      const valor = cookie.split(';')[0];
      vi.setSystemTime(ahoraReal); // vuelve al presente real: emitidoEn queda en el futuro.
      expect(sesionValida(conCookie(valor))).toBe(false);
    });
  });
});
