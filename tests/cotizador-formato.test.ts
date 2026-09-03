import { describe, it, expect } from 'vitest';
import { formatearColones, formatearTasa, formatearDescuentoPersonalizado, formatearEspera } from '@/app/cotizador/formato';

describe('formatearDescuentoPersonalizado', () => {
  it('un descuento general se lee "N% general"', () => {
    expect(formatearDescuentoPersonalizado({ general: 20 })).toBe('20% general');
  });

  it('un descuento por familia lista cada una con su etiqueta legible, no la clave interna', () => {
    const texto = formatearDescuentoPersonalizado({ familias: { toallas: 10, bata: 5 } });
    expect(texto).toContain('Toallas 10%');
    expect(texto).toContain('Batas 5%');
    // La clave interna ('sets-cama', con guion) no debe filtrarse tal cual.
    expect(texto).not.toContain('sets-cama');
  });

  it('respeta el orden de las claves tal como llegan', () => {
    expect(formatearDescuentoPersonalizado({ familias: { bata: 5, toallas: 10 } })).toBe('Batas 5%, Toallas 10%');
  });
});

describe('formatearEspera', () => {
  const AHORA = new Date('2026-08-26T12:00:00.000Z');

  it('menos de una hora: en minutos', () => {
    expect(formatearEspera('2026-08-26T11:45:00.000Z', AHORA)).toBe('15 min');
  });

  it('menos de un día: en horas, singular para 1', () => {
    expect(formatearEspera('2026-08-26T09:00:00.000Z', AHORA)).toBe('3 horas');
    expect(formatearEspera('2026-08-26T11:00:00.000Z', AHORA)).toBe('1 hora');
  });

  it('un día o más: en días, singular para 1', () => {
    expect(formatearEspera('2026-08-23T12:00:00.000Z', AHORA)).toBe('3 días');
    expect(formatearEspera('2026-08-25T12:00:00.000Z', AHORA)).toBe('1 día');
  });
});

// Mismos formateadores que ya cubrían pruebas de pantalla completa (p. ej.
// tests/cotizador-ui.test.tsx) — acá se ancla su comportamiento puro y
// directo, sin montar ningún componente, ahora que otras dos pantallas
// (VistaCrear, VistaAprobaciones) también dependen de este archivo.
describe('formatearColones / formatearTasa', () => {
  it('agrupa los miles con punto y antepone el símbolo', () => {
    expect(formatearColones(1234567)).toBe('₡1.234.567');
  });

  it('la tasa no imprime ceros de más', () => {
    expect(formatearTasa(0.13)).toBe('13');
    expect(formatearTasa(0.025)).toBe('2.5');
  });
});
