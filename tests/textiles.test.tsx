import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Textiles } from '@/components/sections/Textiles';
import { copy } from '@/content/copy';

describe('Textiles', () => {
  it('describe las seis familias de producto', () => {
    render(<Textiles />);
    for (const f of copy.textiles.familias) {
      expect(screen.getByText(f.nombre)).toBeInTheDocument();
      expect(screen.getByText(f.detalle)).toBeInTheDocument();
    }
  });

  it('lista las cinco medidas', () => {
    render(<Textiles />);
    for (const m of copy.textiles.medidas) {
      expect(screen.getByText(m)).toBeInTheDocument();
    }
  });

  it('conserva las especificaciones que un comprador compara', () => {
    const todo = JSON.stringify(copy.textiles);
    for (const dato of ['600 hilos', '100 % algodón', 'Down Alternative', 'Quilting', 'Pinsonic', '2.5 pulgadas']) {
      expect(todo).toContain(dato);
    }
  });

  it('no publica precios, códigos ni la marca del proveedor', () => {
    const { container } = render(<Textiles />);
    const texto = container.textContent ?? '';
    // El catálogo de origen trae precios en quetzales, códigos de producto
    // y la marca del proveedor. Nada de eso pertenece a este sitio: es
    // lista de distribuidor, en otra moneda y otro mercado.
    expect(texto).not.toMatch(/Q\s?\d/);
    expect(texto).not.toMatch(/COD[:\s]/i);
    expect(texto.toLowerCase()).not.toContain('bodega del edredón');
    expect(texto.toLowerCase()).not.toContain('bde');
  });
});
