import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Proceso } from '@/components/sections/Proceso';
import { Personalizacion } from '@/components/sections/Personalizacion';
import { Footer } from '@/components/sections/Footer';
import { copy } from '@/content/copy';

describe('Proceso', () => {
  it('lista los siete pasos en orden', () => {
    render(<Proceso />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(copy.proceso.pasos.length);
    copy.proceso.pasos.forEach((paso, i) => {
      expect(items[i]).toHaveTextContent(paso.nombre);
    });
  });

  it('numera cada paso', () => {
    render(<Proceso />);
    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByText('07')).toBeInTheDocument();
  });
});

describe('Personalizacion', () => {
  it('nombra las cuatro técnicas', () => {
    render(<Personalizacion />);
    for (const t of copy.personalizacion.tecnicas) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
  });
});

describe('Footer', () => {
  it('es un contentinfo con el año actual', () => {
    render(<Footer />);
    const pie = screen.getByRole('contentinfo');
    expect(pie).toHaveTextContent(String(new Date().getFullYear()));
  });
});
