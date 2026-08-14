import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { GlassCard } from '@/components/ui/GlassCard';
import { Button } from '@/components/ui/Button';
import { AuroraBackground } from '@/components/background/AuroraBackground';

describe('GlassCard', () => {
  it('rinde su contenido', () => {
    render(<GlassCard>contenido</GlassCard>);
    expect(screen.getByText('contenido')).toBeInTheDocument();
  });

  it('usa el relleno oscuro por defecto', () => {
    const { container } = render(<GlassCard>x</GlassCard>);
    expect(container.firstElementChild).toHaveClass('bg-[var(--glass-fill)]');
  });

  it('usa la placa clara en la variante plate', () => {
    const { container } = render(<GlassCard variant="plate">x</GlassCard>);
    expect(container.firstElementChild).toHaveClass('bg-[var(--plate-fill)]');
  });
});

describe('Button', () => {
  it('el primario va beige con texto navy, nunca teal de fondo', () => {
    const { container } = render(<Button>Cotizar</Button>);
    const el = container.firstElementChild!;
    expect(el).toHaveClass('bg-beige');
    expect(el).toHaveClass('text-navy');
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

describe('AuroraBackground', () => {
  it('queda fuera del árbol de accesibilidad', () => {
    const { container } = render(<AuroraBackground />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});
