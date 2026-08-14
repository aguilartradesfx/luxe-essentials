import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Hero } from '@/components/sections/Hero';
import { copy } from '@/content/copy';

describe('Hero', () => {
  it('pone el título en el único h1', () => {
    render(<Hero />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(copy.hero.titulo);
  });

  it('lleva el CTA principal al formulario', () => {
    render(<Hero />);
    expect(screen.getByRole('link', { name: copy.hero.ctaPrimario })).toHaveAttribute(
      'href',
      '#cotizacion',
    );
  });

  it('muestra los cuatro atributos del deck', () => {
    render(<Hero />);
    expect(copy.hero.atributos).toHaveLength(4);
    for (const attr of copy.hero.atributos) {
      expect(screen.getByText(attr)).toBeInTheDocument();
    }
  });
});
