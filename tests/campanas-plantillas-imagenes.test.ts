// tests/campanas-plantillas-imagenes.test.ts
//
// Ancla la imagen de producto que ahora llevan inicial/seguimiento_1/
// seguimiento_2, y su ausencia deliberada en seguimiento_3 (la de cierre)
// -- contra las plantillas REALES. Cubre lo que el encargo pidió
// explícitamente para el caso de imágenes bloqueadas: texto alternativo
// específico, width/height como atributo (no sólo en el estilo) y un color
// de respaldo en la celda que la envuelve.
import { describe, it, expect } from 'vitest';
import { plantillaCargada } from '@/lib/campanas/plantillas';

// La imagen de producto que le toca a cada una de las tres (criterio
// comercial en el reporte de la tarea), y el texto alternativo esperado --
// no exhaustivo, sólo lo bastante específico para que un mutante que
// intercambie dos imágenes entre plantillas, o que vacíe el alt, falle.
const IMAGEN: Record<'inicial' | 'seguimiento_1' | 'seguimiento_2', { id: string; altContiene: string }> = {
  inicial: { id: 'seccion-uniformes', altContiene: 'uniforme corporativo' },
  seguimiento_1: { id: 'seccion-telas', altContiene: 'azul marino, blanco y crudo' },
  // El alt decía "aplicando un logo ... en la planta de Luxe Essentials", y
  // las dos cosas eran falsas: la imagen es una bordadora cosiendo un diseño
  // abstracto sobre tela azul marino en un bastidor, y no es la planta de
  // nadie (es una de las generadas con IA). El alt es lo único que lee quien
  // tiene las imágenes bloqueadas -- común en hoteles con Outlook
  // corporativo -- así que era una afirmación falsa dicha sólo a esas
  // personas. Se ancla ahora contra el bastidor: es lo que de verdad se ve
  // y lo que distingue esta foto de las otras dos.
  seguimiento_2: { id: 'seccion-bordado', altContiene: 'bordadora cosiendo un dise' },
};

const PLANTILLAS_CON_CTA = ['inicial', 'seguimiento_1', 'seguimiento_2'] as const;

describe('imagen de producto, en las tres plantillas que llevan CTA', () => {
  it.each(PLANTILLAS_CON_CTA)('%s: la imagen es la elegida para esta plantilla, servida en JPEG desde el dominio del sitio', (plantilla) => {
    const { html } = plantillaCargada(plantilla);
    const { id } = IMAGEN[plantilla];
    expect(html).toContain(
      `src="https://www.luxeessentialscr.com/images/correo/${id}.jpg"`,
    );
    // JPEG, no WebP -- Outlook para Windows no pinta WebP.
    expect(html).not.toMatch(new RegExp(`images/correo/${id}\\.webp`));
  });

  it.each(PLANTILLAS_CON_CTA)('%s: la imagen declara width y height como atributo (no sólo en el estilo)', (plantilla) => {
    const { html } = plantillaCargada(plantilla);
    const { id } = IMAGEN[plantilla];
    const inicioImg = html.indexOf(`images/correo/${id}.jpg`);
    expect(inicioImg).toBeGreaterThan(-1);
    // La propia etiqueta <img ...> completa, para inspeccionar sus atributos.
    const cierre = html.indexOf('>', inicioImg);
    const etiqueta = html.slice(html.lastIndexOf('<img', inicioImg), cierre + 1);
    expect(etiqueta).toMatch(/width="512"/);
    expect(etiqueta).toMatch(/height="288"/);
    // Nunca imagen de fondo -- Outlook la ignora.
    expect(html).not.toMatch(/background(-image)?\s*:\s*url\(/i);
  });

  it.each(PLANTILLAS_CON_CTA)('%s: el texto alternativo de la imagen es específico, no genérico', (plantilla) => {
    const { html } = plantillaCargada(plantilla);
    const { id, altContiene } = IMAGEN[plantilla];
    const inicioImg = html.indexOf(`images/correo/${id}.jpg`);
    const cierre = html.indexOf('>', inicioImg);
    const etiqueta = html.slice(html.lastIndexOf('<img', inicioImg), cierre + 1);
    const alt = etiqueta.match(/alt="([^"]*)"/)?.[1] ?? '';
    expect(alt.length).toBeGreaterThan(10);
    expect(alt).toContain(altContiene);
  });

  it.each(PLANTILLAS_CON_CTA)('%s: la celda que envuelve la imagen tiene un color de respaldo si el cliente bloquea imágenes', (plantilla) => {
    const { html } = plantillaCargada(plantilla);
    const { id } = IMAGEN[plantilla];
    const inicioImg = html.indexOf(`images/correo/${id}.jpg`);
    // El bgcolor vive en el <td> que abre justo antes del <img> -- se busca
    // hacia atrás desde la imagen, no en cualquier parte del documento.
    const bloque = html.slice(Math.max(0, inicioImg - 400), inicioImg);
    expect(bloque).toMatch(/bgcolor="#F1F3F6"/);
  });
});

describe('seguimiento_3 (la de cierre): sin imagen de producto, a propósito', () => {
  it('no tiene ninguna imagen de producto', () => {
    const { html } = plantillaCargada('seguimiento_3');
    expect(html).not.toMatch(/<img\b/);
    expect(html).not.toContain('images/correo/');
  });
});
