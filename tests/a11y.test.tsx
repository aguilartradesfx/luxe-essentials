import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Home from '@/app/page';
// Desde `app/metadata.ts`, no desde `app/layout.tsx`: el layout importa
// `next/font/google`, que sólo funciona dentro del compilador de Next.
import { siteMetadata as metadata } from '@/app/metadata';

describe('estructura de la página', () => {
  it('tiene un solo h1', () => {
    const { container } = render(<Home />);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('no salta de h1 a h3 sin h2 intermedio', () => {
    const { container } = render(<Home />);
    const niveles = [...container.querySelectorAll('h1,h2,h3')].map((h) =>
      Number(h.tagName[1]),
    );
    for (let i = 1; i < niveles.length; i++) {
      expect(niveles[i] - niveles[i - 1]).toBeLessThanOrEqual(1);
    }
  });

  it('da texto alternativo a toda imagen', () => {
    const { container } = render(<Home />);
    for (const img of container.querySelectorAll('img')) {
      expect(img.getAttribute('alt')).toBeTruthy();
    }
  });
});

describe('metadata', () => {
  it('declara título, descripción y openGraph', () => {
    expect(metadata.title).toBeTruthy();
    expect(metadata.description).toBeTruthy();
    expect(metadata.openGraph).toBeTruthy();
  });

  it('declara metadataBase para resolver las urls absolutas', () => {
    expect(metadata.metadataBase).toBeTruthy();
  });
});
