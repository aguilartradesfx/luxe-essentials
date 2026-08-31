import { describe, it, expect } from 'vitest';
import { generarInvitacion, huellaDe, HORAS_VIGENCIA } from '@/lib/cotizador/invitaciones';

describe('invitaciones', () => {
  it('genera un enlace de 32 bytes en hexadecimal', () => {
    expect(generarInvitacion().enlace).toMatch(/^[0-9a-f]{64}$/);
  });

  it('no repite el enlace', () => {
    expect(generarInvitacion().enlace).not.toBe(generarInvitacion().enlace);
  });

  // Lo que se guarda es la huella. Si alguien lee la tabla no puede
  // reconstruir ningún enlace vivo.
  it('la huella no contiene el enlace y es determinista', () => {
    const { enlace, huella } = generarInvitacion();
    expect(huella).not.toContain(enlace);
    expect(huella).toMatch(/^[0-9a-f]{64}$/);
    expect(huellaDe(enlace)).toBe(huella);
  });

  it('vence a las 72 horas', () => {
    const antes = Date.now();
    const { expira } = generarInvitacion();
    const horas = (expira.getTime() - antes) / 3_600_000;
    expect(HORAS_VIGENCIA).toBe(72);
    expect(horas).toBeGreaterThan(71.9);
    expect(horas).toBeLessThan(72.1);
  });
});
