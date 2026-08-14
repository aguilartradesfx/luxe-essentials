import { render } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
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
    const imagenes = container.querySelectorAll('img');
    // Guarda contra un falso positivo silencioso: si un refactor futuro
    // deja la página sin <img>, el for de abajo no ejecuta ninguna
    // aserción y la prueba "pasaría" sin haber comprobado nada.
    expect(imagenes.length).toBeGreaterThan(0);
    for (const img of imagenes) {
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

describe('metadata: NEXT_PUBLIC_SITE_URL vacía', () => {
  const original = process.env.NEXT_PUBLIC_SITE_URL;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    } else {
      process.env.NEXT_PUBLIC_SITE_URL = original;
    }
    vi.resetModules();
  });

  it('cae al localhost por defecto en vez de lanzar "Invalid URL"', async () => {
    // El flujo de `cp .env.example .env.local` deja la variable declarada
    // pero vacía (`NEXT_PUBLIC_SITE_URL=`), no ausente. `??` no cubre ese
    // caso porque `''` no es `null`/`undefined`; sólo `||` lo cubre.
    process.env.NEXT_PUBLIC_SITE_URL = '';
    vi.resetModules();
    const { siteMetadata } = await import('@/app/metadata');
    expect(siteMetadata.metadataBase?.toString()).toBe('http://localhost:3000/');
  });
});
