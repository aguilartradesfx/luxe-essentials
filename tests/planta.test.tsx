import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Planta } from '@/components/sections/Planta';
import { copy } from '@/content/copy';

describe('Planta', () => {
  it('describe las cuatro áreas de la planta', () => {
    render(<Planta />);
    for (const area of copy.planta.areas) {
      expect(screen.getByText(area.nombre)).toBeInTheDocument();
      expect(screen.getByText(area.detalle)).toBeInTheDocument();
    }
  });

  it('lista las telas con las que se trabaja', () => {
    render(<Planta />);
    for (const m of copy.planta.materiales) {
      expect(screen.getByText(m)).toBeInTheDocument();
    }
  });

  it('deja claro que la planta no es de Luxe, sino del fabricante que representa', () => {
    render(<Planta />);
    // Ésta es la invariante que importa. El sitio ya afirmó una vez tener
    // planta propia y 250 operarios cuando ni una cosa ni la otra eran
    // suyas; la sección existe precisamente para contar esa capacidad sin
    // volver a apropiársela.
    const intro = copy.planta.intro.toLowerCase();
    expect(intro).toContain('no fabricamos');
    expect(intro).toContain('representamos');
    expect(screen.getByText(copy.planta.intro)).toBeInTheDocument();
  });

  it('no se atribuye la planta en ninguna parte del texto de la sección', () => {
    const todo = JSON.stringify(copy.planta).toLowerCase();
    for (const falso of ['nuestra planta', 'planta propia', 'nuestros operarios', 'nuestra fábrica']) {
      expect(todo).not.toContain(falso);
    }
  });
});

describe('Figure con proporción forzada', () => {
  it('iguala la altura de las dos imágenes de la sección', async () => {
    const { container } = render(<Planta />);
    const marcos = [...container.querySelectorAll('div[style*="aspect-ratio"]')];
    // Las dos fotos son 4:3 y 16:9 en el manifest: sin igualarlas, en la
    // misma fila una queda visiblemente más alta que la otra.
    const proporciones = new Set(marcos.map((m) => (m as HTMLElement).style.aspectRatio));
    expect(marcos).toHaveLength(2);
    expect(proporciones.size).toBe(1);
  });
});
