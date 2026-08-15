import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA, getMedia } from '@/content/media';
import { Figure } from '@/components/ui/Figure';
import { copy } from '@/content/copy';

describe('manifest de medios', () => {
  it('da texto alternativo a toda entrada, incluidas las pendientes', () => {
    for (const entry of MEDIA) {
      expect(entry.alt.trim().length, `${entry.id} sin alt`).toBeGreaterThan(0);
    }
  });

  it('respalda con archivo toda entrada no pendiente', () => {
    for (const entry of MEDIA.filter((e) => !e.pending)) {
      const ruta = join(process.cwd(), 'public', 'images', `${entry.id}.webp`);
      expect(existsSync(ruta), `falta ${entry.id}.webp`).toBe(true);
    }
  });

  it('falla ruidosamente ante un identificador desconocido', () => {
    // @ts-expect-error identificador inexistente a propósito
    expect(() => getMedia('no-existe')).toThrow();
  });
});

describe('Figure', () => {
  it('rinde la imagen con su alt cuando el archivo existe', () => {
    render(<Figure id="planta-bordado" />);
    expect(screen.getByAltText(getMedia('planta-bordado').alt)).toBeInTheDocument();
  });

  it('rinde un marcador con el brief cuando la entrada está pendiente', () => {
    render(<Figure id="equipo-luxe" />);
    expect(screen.getByRole('img', { name: getMedia('equipo-luxe').alt })).toBeInTheDocument();
    expect(screen.getByText(/Pendiente/i)).toBeInTheDocument();
  });

  it('el texto del marcador sale de content/copy.ts, no está escrito en el componente', () => {
    render(<Figure id="equipo-luxe" />);
    expect(screen.getByText(copy.medios.pendiente)).toBeInTheDocument();
  });

  it('el marcador pendiente va en navy sobre blanco, sin teal', () => {
    const { container } = render(<Figure id="equipo-luxe" />);
    const etiqueta = screen.getByText(copy.medios.pendiente);
    // Teal sobre beige mide 3.95:1 y este rótulo es text-xs: no llega al
    // 4.5:1 de AA. Navy/80 sobre blanco da 5.59:1.
    expect(etiqueta).toHaveClass('text-navy/80');
    expect(etiqueta.className).not.toMatch(/text-teal/);
    expect(container.querySelector('.bg-white')).not.toBeNull();
  });
});
