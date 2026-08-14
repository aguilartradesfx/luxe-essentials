import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Capacidad } from '@/components/sections/Capacidad';
import { Cifras } from '@/components/sections/Cifras';
import { Lineas } from '@/components/sections/Lineas';
import { copy } from '@/content/copy';

describe('Capacidad', () => {
  it('muestra todos sus párrafos', () => {
    render(<Capacidad />);
    for (const p of copy.capacidad.parrafos) {
      expect(screen.getByText(p)).toBeInTheDocument();
    }
  });
});

describe('Cifras', () => {
  it('muestra las tres cifras con su etiqueta', () => {
    render(<Cifras />);
    for (const c of copy.cifras) {
      expect(screen.getByText(c.valor)).toBeInTheDocument();
      expect(screen.getByText(c.etiqueta)).toBeInTheDocument();
    }
  });
});

describe('Lineas', () => {
  it('presenta las dos líneas con sus categorías', () => {
    render(<Lineas />);
    for (const linea of copy.lineas.items) {
      const tarjeta = screen.getByRole('article', { name: linea.nombre });
      for (const cat of linea.categorias) {
        expect(within(tarjeta).getByText(cat)).toBeInTheDocument();
      }
    }
  });

  it('no publica precios', () => {
    const { container } = render(<Lineas />);
    expect(container.textContent).not.toMatch(/Q\s?\d/);
  });

  it('expone el ancla de navegación', () => {
    const { container } = render(<Lineas />);
    expect(container.querySelector('#lineas')).not.toBeNull();
  });
});
