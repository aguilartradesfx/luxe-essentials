import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { GlassCard } from '@/components/ui/GlassCard';
import { Button } from '@/components/ui/Button';

describe('GlassCard', () => {
  it('rinde su contenido', () => {
    render(<GlassCard>contenido</GlassCard>);
    expect(screen.getByText('contenido')).toBeInTheDocument();
  });

  it('por defecto es papel sobre lienzo, sin blur', () => {
    const { container } = render(<GlassCard>x</GlassCard>);
    const el = container.firstElementChild!;
    expect(el).toHaveClass('bg-[var(--carta-fill)]');
    // El blur sólo tiene sentido sobre fotografía: sobre un fondo plano
    // no refracta nada y sólo ensucia.
    expect(el.className).not.toMatch(/backdrop-blur/);
  });

  it('la variante panel sí lleva vidrio, para usarse sobre foto', () => {
    const { container } = render(<GlassCard variant="panel">x</GlassCard>);
    const el = container.firstElementChild!;
    expect(el).toHaveClass('bg-[var(--panel-fill)]');
    expect(el.className).toMatch(/backdrop-blur/);
  });

  it('propaga props extra al elemento', () => {
    render(
      <GlassCard as="article" aria-label="Ficha">
        x
      </GlassCard>,
    );
    expect(screen.getByRole('article', { name: 'Ficha' })).toBeInTheDocument();
  });
});

describe('Button', () => {
  it('el primario va navy con texto beige, nunca teal de fondo', () => {
    const { container } = render(<Button>Cotizar</Button>);
    const el = container.firstElementChild!;
    // Sobre lienzo claro la pareja de alto contraste se invierte respecto
    // al diseño oscuro anterior: navy de relleno, beige de texto (~8.3:1).
    expect(el).toHaveClass('bg-navy');
    expect(el).toHaveClass('text-beige');
    // El teal como relleno de un botón daría ~3.9:1 con texto claro.
    expect(el.className).not.toMatch(/bg-teal/);
  });

  it('rinde un enlace cuando recibe href', () => {
    render(<Button href="#cotizacion">Cotizar</Button>);
    expect(screen.getByRole('link', { name: 'Cotizar' })).toHaveAttribute('href', '#cotizacion');
  });

  it('rinde un botón cuando no recibe href', () => {
    render(<Button>Enviar</Button>);
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeInTheDocument();
  });
});
