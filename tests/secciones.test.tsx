import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Capacidad } from '@/components/sections/Capacidad';
import { Cifras } from '@/components/sections/Cifras';
import { Lineas } from '@/components/sections/Lineas';
import { copy } from '@/content/copy';
import { getMedia } from '@/content/media';

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

  it('la etiqueta de marca usa sky completo, no sky/80 (finding 4: nada visible debe reprobar AA)', () => {
    render(<Lineas />);
    for (const linea of copy.lineas.items) {
      const etiqueta = screen.getByText(linea.marca);
      expect(etiqueta).toHaveClass('text-sky');
      expect(etiqueta.className).not.toMatch(/text-sky\/80/);
    }
  });

  it('la foto de la línea completa de uniformes usa la placa clara, igual que el hero (§8.2)', () => {
    render(<Lineas />);
    const img = screen.getByAltText(getMedia('cocina-linea-completa').alt);
    // La placa es el propio GlassCard variant="plate": lleva `isolate` y
    // `[&_img]:mix-blend-multiply` para fundir el fondo blanco de estudio
    // en vez de que se lea como un recorte pegado sobre el navy.
    const placa = img.closest('.isolate');
    expect(placa).not.toBeNull();
    expect(placa).toHaveClass('bg-[var(--plate-fill)]');
    expect(placa!.className).toMatch(/mix-blend-multiply/);
  });
});
