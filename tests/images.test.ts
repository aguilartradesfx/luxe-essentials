import { describe, it, expect } from 'vitest';
import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCES } from '@/scripts/optimize-images.mjs';

const DIR = join(process.cwd(), 'public', 'images');

describe('imágenes optimizadas', () => {
  it('genera un webp por cada imagen de origen', () => {
    for (const { id } of SOURCES) {
      expect(existsSync(join(DIR, `${id}.webp`)), `falta ${id}.webp`).toBe(true);
    }
  });

  it('mantiene el peso total por debajo de 8 MB', () => {
    const total = SOURCES.reduce((sum, { id }) => sum + statSync(join(DIR, `${id}.webp`)).size, 0);
    expect(total).toBeLessThan(8 * 1024 * 1024);
  });

  it('no repite identificadores', () => {
    const ids = SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
