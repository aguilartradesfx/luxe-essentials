// tests/cotizador-catalogo.test.ts
import { describe, it, expect } from 'vitest';
import { CATALOGO, buscarSku } from '@/lib/cotizador/catalogo';
import { ESCALAS } from '@/lib/cotizador/escalas';
import { GRUPOS, TALLAS, LINEAS_CATALOGO } from '@/lib/cotizador/tipos';

describe('CATALOGO', () => {
  it('tiene los 70 SKUs', () => {
    expect(CATALOGO).toHaveLength(70);
  });

  it('reparte los SKUs por grupo como confirmó Luxe', () => {
    const conteo: Record<string, number> = {};
    for (const s of CATALOGO) conteo[s.grupo] = (conteo[s.grupo] ?? 0) + 1;
    expect(conteo).toEqual({
      uniformes: 22,
      'sets-cama': 16,
      'fundas-insertos': 16,
      toallas: 13,
      bata: 1,
      almohadas: 2,
    });
  });

  it('no repite ids', () => {
    const ids = CATALOGO.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('usa solo grupos, líneas y tallas conocidos', () => {
    for (const s of CATALOGO) {
      expect(GRUPOS).toContain(s.grupo);
      expect(LINEAS_CATALOGO).toContain(s.linea);
      if (s.talla) expect(TALLAS).toContain(s.talla);
      expect(ESCALAS[s.grupo]).toBeDefined();
    }
  });

  it('tiene precios enteros y positivos', () => {
    for (const s of CATALOGO) {
      expect(Number.isInteger(s.precioLista)).toBe(true);
      expect(s.precioLista).toBeGreaterThan(0);
    }
  });

  it('desglosa el contenido de todos los sets de cama y de nada más', () => {
    for (const s of CATALOGO) {
      if (s.grupo === 'sets-cama') expect(s.contenido?.length).toBeGreaterThan(0);
      else expect(s.contenido).toBeUndefined();
    }
  });

  it('da 1 sobrefunda a imperial y 2 al resto', () => {
    for (const s of CATALOGO.filter((x) => x.grupo === 'sets-cama')) {
      const esperado = s.talla === 'imperial' ? '1 sobrefunda' : '2 sobrefundas';
      expect(s.contenido).toContain(esperado);
    }
  });

  it('lleva las correcciones que Luxe confirmó después del archivo', () => {
    expect(buscarSku('toalla-680-facial')!.precioLista).toBe(3000);
    expect(buscarSku('toalla-680-mano')!.precioLista).toBe(3500);
    expect(buscarSku('toalla-de-pie')!.precioLista).toBe(5000);
  });

  it('tiene una sola toalla de pie', () => {
    const pies = CATALOGO.filter((s) => s.nombre.includes('toalla de pie'));
    expect(pies).toHaveLength(1);
  });

  it('mantiene la facial más barata que la de mano en los tres gramajes', () => {
    for (const g of [680, 460, 360]) {
      const facial = buscarSku(`toalla-${g}-facial`)!;
      const mano = buscarSku(`toalla-${g}-mano`)!;
      expect(facial.precioLista).toBeLessThan(mano.precioLista);
    }
  });

  it('conserva precios de referencia del archivo', () => {
    expect(buscarSku('set-600-king')!.precioLista).toBe(90000);
    expect(buscarSku('inserto-de-duvet-king')!.precioLista).toBe(75000);
    expect(buscarSku('bata-blanca')!.precioLista).toBe(25000);
  });

  it('buscarSku devuelve undefined para un id inexistente', () => {
    expect(buscarSku('no-existe')).toBeUndefined();
  });
});
