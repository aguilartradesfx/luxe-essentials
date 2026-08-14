import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA, getMedia } from '@/content/media';
import { Figure } from '@/components/ui/Figure';

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
    render(<Figure id="hogar-cama-vestida" />);
    expect(screen.getByRole('img', { name: getMedia('hogar-cama-vestida').alt })).toBeInTheDocument();
    expect(screen.getByText(/Pendiente/i)).toBeInTheDocument();
  });
});
