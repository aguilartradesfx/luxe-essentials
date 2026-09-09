// tests/campanas-plantillas.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { plantillaCargada, todasLasPlantillas, construirPlantillaCargada } from '@/lib/campanas/plantillas';
import { renderizarPlantilla } from '@/lib/campanas/marcadores';
import { PLANTILLAS } from '@/lib/campanas/envio';

const DIR = path.join(process.cwd(), 'lib', 'campanas', 'plantillas');

const ASUNTOS_ESPERADOS: Record<string, string> = {
  inicial: 'Uniformes y textiles en 30-35 dias | Luxe Essentials',
  seguimiento_1: 'La misma tela dentro de un ano | Luxe Essentials',
  seguimiento_2: 'Como se ve el proceso, en concreto | Luxe Essentials',
  seguimiento_3: 'Cierro el tema? | Luxe Essentials',
};

describe('plantillaCargada', () => {
  it('carga las cuatro plantillas de PLANTILLAS, ni una de más ni de menos', () => {
    expect(todasLasPlantillas().map((p) => p.plantilla)).toEqual([...PLANTILLAS]);
  });

  it.each(PLANTILLAS)('%s: el asunto es el <title> literal, tildes incluidas u omitidas tal cual el autor las dejó', (plantilla) => {
    const p = plantillaCargada(plantilla);
    expect(p.asunto).toBe(ASUNTOS_ESPERADOS[plantilla]);
  });

  it('el asunto NO se "corrige" agregándole tildes que el original no tiene', () => {
    // Los títulos originales vienen sin tildes a propósito (dias, ano,
    // Como) -- si algo alguna vez "arreglara" esto, este assert lo detecta.
    expect(plantillaCargada('inicial').asunto).toContain('dias');
    expect(plantillaCargada('inicial').asunto).not.toContain('días');
    expect(plantillaCargada('seguimiento_1').asunto).toContain('ano');
  });

  it('la vista previa es el contenido del div oculto, con los espacios invisibles finales intactos', () => {
    const p = plantillaCargada('inicial');
    expect(p.previewText).toBe(
      'Importar por cuenta propia toma 60 a 90 dias. Nosotros entregamos en 30 a 35.' +
        '&#8203;&nbsp;'.repeat(10),
    );
  });

  it('la vista previa de cada plantilla es distinta (cambia por plantilla, como el resto del texto editable)', () => {
    const previews = PLANTILLAS.map((p) => plantillaCargada(p).previewText);
    expect(new Set(previews).size).toBe(PLANTILLAS.length);
  });

  it('el html devuelto es exactamente el archivo en disco, sin ninguna transformación', () => {
    for (const plantilla of PLANTILLAS) {
      const enDisco = readFileSync(path.join(DIR, `${plantilla}.html`), 'utf8');
      expect(plantillaCargada(plantilla).html).toBe(enDisco);
    }
  });

  it('ninguna plantilla conserva la coma vieja delante de {{nombre}}: la única edición ya está hecha', () => {
    for (const plantilla of PLANTILLAS) {
      expect(plantillaCargada(plantilla).html).not.toMatch(/,\s*\{\{nombre\}\}/);
    }
  });

  // Hallazgo importante (revisión final, punto 4): la plantilla
  // PERSONALIZADA ya exigía {{unsubscribe_url}} (validarMarcadorBaja, con
  // sus propias pruebas) -- las cuatro FIJAS no tenían ni la comprobación
  // ni una prueba, así que una edición en caliente (el botón de WhatsApp,
  // las imágenes -- ya pasó dos veces) que se llevara por delante el pie
  // del correo no lo habría notado nadie hasta mandar una campaña sin baja.
  // Esta prueba confirma que los CUATRO archivos reales siguen trayendo el
  // marcador -- la que de verdad ancla la exigencia (que `cargar` REVIENTE
  // si algún día falta) es la siguiente, contra `construirPlantillaCargada`.
  it('las cuatro plantillas reales pasan validarMarcadorBaja -- el pie con el enlace de baja sigue ahí', () => {
    for (const plantilla of PLANTILLAS) {
      const { html } = plantillaCargada(plantilla);
      expect(html).toContain('{{unsubscribe_url}}');
    }
  });
});

describe('construirPlantillaCargada: la misma exigencia que la plantilla personalizada', () => {
  // Mata al mutante que borrara (o vaciara) el chequeo de
  // `validarMarcadorBaja` dentro de `construirPlantillaCargada`: sin él,
  // esta prueba fallaría porque NO lanzaría con un html sin el marcador --
  // y una edición futura que se lo lleve por delante pasaría desapercibida
  // hasta que ya se mandó una campaña sin baja.
  it('un html sin {{unsubscribe_url}} no carga -- revienta con el mismo error que validarMarcadorBaja', () => {
    expect(() =>
      construirPlantillaCargada('inicial', 'prueba.html', '<html><body>Sin enlace de baja.</body></html>'),
    ).toThrow(/\{\{unsubscribe_url\}\}/);
  });

  it('un html CON el marcador carga normalmente (no revienta de más)', () => {
    const html =
      '<html><head><title>Asunto de prueba</title></head><body>' +
      `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#E9ECF0;opacity:0;">Vista previa</div>` +
      '<a href="{{unsubscribe_url}}">Baja</a></body></html>';
    const cargada = construirPlantillaCargada('inicial', 'prueba.html', html);
    expect(cargada.asunto).toBe('Asunto de prueba');
    expect(cargada.previewText).toBe('Vista previa');
    expect(cargada.html).toBe(html);
  });
});

describe('renderizarPlantilla contra las plantillas reales', () => {
  it('inicial: resuelve nombre, empresa y baja en el html real', () => {
    const { html } = plantillaCargada('inicial');
    const resultado = renderizarPlantilla(html, {
      nombreCrm: 'Ana Rodríguez',
      unsubscribeUrl: 'https://luxeessentialscr.com/baja?t=abc',
    });
    expect(resultado).toContain('Buenos d&iacute;as, Ana:');
    expect(resultado).toContain('Le escribimos porque Ana Rodríguez opera con personal uniformado.');
    expect(resultado).toContain('href="https://luxeessentialscr.com/baja?t=abc"');
    expect(resultado).not.toContain('{{');
  });

  // El caso real que señaló el encargo: seguimiento_3.html trae {{nombre}}
  // DOS veces (el saludo y el cierre "Gracias por el tiempo{{nombre}}.").
  // Mata al mismo mutante que ya probaba tests/campanas-marcadores.test.ts
  // con un fixture armado a mano -- acá, contra el archivo real -- y
  // confirma que las DOS apariciones se resuelven, no sólo la primera.
  it('seguimiento_3: resuelve las DOS apariciones de {{nombre}} (saludo y cierre)', () => {
    const { html } = plantillaCargada('seguimiento_3');
    expect(html.match(/\{\{nombre\}\}/g)).toHaveLength(2);

    const personalizado = renderizarPlantilla(html, {
      nombreCrm: 'Ana Rodríguez',
      unsubscribeUrl: 'https://x.cr/baja',
    });
    expect(personalizado).toContain('Buenos d&iacute;as, Ana:');
    expect(personalizado).toContain('Gracias por el tiempo, Ana. Un gusto.');
    expect(personalizado).not.toContain('{{nombre}}');

    const generico = renderizarPlantilla(html, {
      nombreCrm: 'supermercado poval',
      unsubscribeUrl: 'https://x.cr/baja',
    });
    expect(generico).toContain('Buenos d&iacute;as:');
    expect(generico).toContain('Gracias por el tiempo. Un gusto.');
    // Sin coma suelta en ninguna de las dos apariciones.
    expect(generico).not.toMatch(/d&iacute;as\s*,\s*:/);
    expect(generico).not.toMatch(/tiempo\s*,\s*\./);
  });

  it('las cuatro plantillas, con cualquier nombre, terminan sin ningún marcador sin resolver', () => {
    for (const plantilla of PLANTILLAS) {
      const { html } = plantillaCargada(plantilla);
      const resultado = renderizarPlantilla(html, {
        nombreCrm: 'restaurante ardere',
        unsubscribeUrl: 'https://x.cr/baja',
      });
      expect(resultado).not.toMatch(/\{\{(nombre|empresa|unsubscribe_url)\}\}/);
    }
  });
});
