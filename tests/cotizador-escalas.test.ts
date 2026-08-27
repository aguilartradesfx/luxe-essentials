import { describe, it, expect } from 'vitest';
import { ESCALAS, escalonDe } from '@/lib/cotizador/escalas';
import { GRUPOS } from '@/lib/cotizador/tipos';

const uniformes = ESCALAS.uniformes;
const sets = ESCALAS['sets-cama'];

describe('escalonDe', () => {
  it('no descuenta por debajo del primer umbral', () => {
    expect(escalonDe(23, uniformes)).toEqual({ desde: 0, pct: 0 });
  });

  it('aplica el 5% justo en el umbral', () => {
    expect(escalonDe(24, uniformes)).toEqual({ desde: 24, pct: 5 });
  });

  it('mantiene el 5% hasta el último valor antes del siguiente escalón', () => {
    expect(escalonDe(47, uniformes)).toEqual({ desde: 24, pct: 5 });
  });

  it('aplica el 10% justo en el segundo umbral', () => {
    expect(escalonDe(48, uniformes)).toEqual({ desde: 48, pct: 10 });
  });

  it('mantiene el 10% muy por encima del umbral', () => {
    expect(escalonDe(5000, uniformes)).toEqual({ desde: 48, pct: 10 });
  });

  it('cantidad cero no descuenta', () => {
    expect(escalonDe(0, uniformes)).toEqual({ desde: 0, pct: 0 });
  });

  it('usa los umbrales propios de cada grupo', () => {
    expect(escalonDe(10, sets)).toEqual({ desde: 10, pct: 5 });
    expect(escalonDe(15, sets)).toEqual({ desde: 10, pct: 5 });
    expect(escalonDe(16, sets)).toEqual({ desde: 16, pct: 10 });
  });
});

describe('ESCALAS', () => {
  it('cubre los seis grupos', () => {
    for (const g of GRUPOS) expect(ESCALAS[g]).toBeDefined();
  });

  it('lleva los umbrales confirmados por Luxe el 2026-08-26', () => {
    const esperado: Record<string, [number, number]> = {
      uniformes: [24, 48],
      'sets-cama': [10, 16],
      'fundas-insertos': [12, 24],
      toallas: [24, 48],
      bata: [24, 48],
      almohadas: [12, 24],
    };
    for (const [grupo, [cinco, diez]] of Object.entries(esperado)) {
      expect(escalonDe(cinco, ESCALAS[grupo as keyof typeof ESCALAS]).pct).toBe(5);
      expect(escalonDe(diez, ESCALAS[grupo as keyof typeof ESCALAS]).pct).toBe(10);
    }
  });

  it('tiene los escalones ordenados de mayor a menor', () => {
    for (const g of GRUPOS) {
      const desdes = ESCALAS[g].escalones.map((e) => e.desde);
      expect(desdes).toEqual([...desdes].sort((a, b) => b - a));
    }
  });
});
