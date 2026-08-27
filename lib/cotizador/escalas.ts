import type { Escala, Escalon, GrupoDescuento } from '@/lib/cotizador/tipos';

// Tasa general de IVA en Costa Rica. Es el valor por defecto, no una constante
// del cálculo: hay ventas a tasa reducida y `calcular` recibe la tasa como dato.
export const IVA_GENERAL = 0.13;

// Confirmadas por Luxe el 2026-08-26. Los seis grupos usan el mismo algoritmo
// y solo cambian los números; por eso son datos y no código.
export const ESCALAS: Record<GrupoDescuento, Escala> = {
  uniformes: {
    grupo: 'uniformes',
    etiqueta: 'Uniformes',
    unidad: 'prendas',
    escalones: [
      { desde: 48, pct: 10 },
      { desde: 24, pct: 5 },
    ],
  },
  'sets-cama': {
    grupo: 'sets-cama',
    etiqueta: 'Sets de cama',
    unidad: 'sets',
    escalones: [
      { desde: 16, pct: 10 },
      { desde: 10, pct: 5 },
    ],
  },
  'fundas-insertos': {
    grupo: 'fundas-insertos',
    etiqueta: 'Fundas e insertos',
    unidad: 'unidades',
    escalones: [
      { desde: 24, pct: 10 },
      { desde: 12, pct: 5 },
    ],
  },
  toallas: {
    grupo: 'toallas',
    etiqueta: 'Toallas',
    unidad: 'unidades',
    escalones: [
      { desde: 48, pct: 10 },
      { desde: 24, pct: 5 },
    ],
  },
  // Grupo propio a propósito. Luxe: "no, las batas solamente tienen descuento
  // si compran 24 y 48 uds. no se pueden unificar." Se muestra junto a las
  // toallas en la pantalla, pero no acumula con ellas.
  bata: {
    grupo: 'bata',
    etiqueta: 'Batas',
    unidad: 'unidades',
    escalones: [
      { desde: 48, pct: 10 },
      { desde: 24, pct: 5 },
    ],
  },
  almohadas: {
    grupo: 'almohadas',
    etiqueta: 'Almohadas',
    unidad: 'paquetes',
    escalones: [
      { desde: 24, pct: 10 },
      { desde: 12, pct: 5 },
    ],
  },
};

const SIN_DESCUENTO: Escalon = { desde: 0, pct: 0 };

export function escalonDe(cantidad: number, escala: Escala): Escalon {
  for (const escalon of escala.escalones) {
    if (cantidad >= escalon.desde) return escalon;
  }
  return SIN_DESCUENTO;
}
