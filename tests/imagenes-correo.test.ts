// tests/imagenes-correo.test.ts
//
// Mismo patrón que tests/images.test.ts (las WebP del sitio), para las
// JPEG que usan las plantillas de campaña. Dos cosas que este archivo
// protege y que no se ven leyendo sólo el .html: que el JPEG de verdad
// exista en disco con el nombre que la plantilla referencia, y que el peso
// se mantenga bajo control -- un correo pesado se recorta en Gmail.
import { describe, it, expect } from 'vitest';
import { statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASIGNACIONES } from '@/scripts/imagenes-correo.mjs';

const DIR = join(process.cwd(), 'public', 'images', 'correo');

describe('imágenes de producto para correo (JPEG, no WebP)', () => {
  it('genera un jpg por cada imagen asignada a una plantilla', () => {
    for (const { id } of ASIGNACIONES) {
      expect(existsSync(join(DIR, `${id}.jpg`)), `falta ${id}.jpg`).toBe(true);
    }
  });

  it('cada imagen individual pesa menos de 150 KB', () => {
    for (const { id } of ASIGNACIONES) {
      const peso = statSync(join(DIR, `${id}.jpg`)).size;
      expect(peso, `${id}.jpg pesa demasiado`).toBeLessThan(150 * 1024);
    }
  });

  it('el total de las tres no pasa de 400 KB', () => {
    const total = ASIGNACIONES.reduce((sum, { id }) => sum + statSync(join(DIR, `${id}.jpg`)).size, 0);
    expect(total).toBeLessThan(400 * 1024);
  });

  it('son JPEG de verdad (firma de archivo), no un WebP renombrado', () => {
    for (const { id } of ASIGNACIONES) {
      const cabecera = readFileSync(join(DIR, `${id}.jpg`)).subarray(0, 3);
      // JPEG siempre arranca con FF D8 FF.
      expect(Array.from(cabecera)).toEqual([0xff, 0xd8, 0xff]);
    }
  });

  it('no repite identificadores ni plantilla de destino', () => {
    const ids = ASIGNACIONES.map((a) => a.id);
    const plantillas = ASIGNACIONES.map((a) => a.plantilla);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(plantillas).size).toBe(plantillas.length);
  });

  // La única razón de este cambio: Outlook para Windows no pinta WebP (se
  // ve un hueco). Si algo alguna vez apuntara una plantilla de vuelta a
  // .webp, esto lo detecta sin tener que abrir Outlook.
  it('las tres asignaciones corresponden a las plantillas que sí llevan CTA (no a seguimiento_3)', () => {
    const plantillas = ASIGNACIONES.map((a) => a.plantilla).sort();
    expect(plantillas).toEqual(['inicial', 'seguimiento_1', 'seguimiento_2']);
  });
});

describe('.vercelignore deja pasar las imágenes de correo pese al *.jpg genérico', () => {
  it('excluye *.jpg en general pero reincluye explícitamente public/images/correo/*.jpg', () => {
    const contenido = readFileSync(join(process.cwd(), '.vercelignore'), 'utf8');
    expect(contenido).toMatch(/^\*\.jpg$/m);
    expect(contenido).toMatch(/^!public\/images\/correo\/\*\.jpg$/m);
    // La excepción tiene que venir DESPUÉS de la regla genérica -- el orden
    // importa en las reglas de ignore al estilo gitignore.
    expect(contenido.indexOf('!public/images/correo/*.jpg')).toBeGreaterThan(
      contenido.indexOf('*.jpg'),
    );
  });
});
