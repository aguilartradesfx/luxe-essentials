// tests/campanas-edicion.test.ts
import { describe, it, expect } from 'vitest';
import {
  extraerParrafosEditables,
  contarParrafosEditables,
  aplicarParrafosEditados,
} from '@/lib/campanas/edicion';
import { plantillaCargada, todasLasPlantillas } from '@/lib/campanas/plantillas';
import { PLANTILLAS } from '@/lib/campanas/envio';
import { renderizarPlantilla } from '@/lib/campanas/marcadores';

// Cuántos párrafos editables tiene, de verdad, cada una de las cuatro
// plantillas reales -- contado a mano leyendo el .html (ver el reporte de
// esta tarea). El saludo (y, en seguimiento_3, la despedida) llevan
// `{{nombre}}` y NO cuentan.
const CANTIDAD_ESPERADA: Record<string, number> = {
  inicial: 3,
  seguimiento_1: 4,
  seguimiento_2: 3,
  seguimiento_3: 3,
};

describe('extraerParrafosEditables / contarParrafosEditables', () => {
  it.each(PLANTILLAS)('%s: extrae exactamente la cantidad esperada de párrafos', (plantilla) => {
    const { html } = plantillaCargada(plantilla);
    expect(extraerParrafosEditables(html)).toHaveLength(CANTIDAD_ESPERADA[plantilla]);
    expect(contarParrafosEditables(html)).toBe(CANTIDAD_ESPERADA[plantilla]);
  });

  it('nunca incluye el saludo ni ningún párrafo con {{nombre}}', () => {
    for (const p of todasLasPlantillas()) {
      const textos = extraerParrafosEditables(p.html).map((x) => x.texto);
      expect(textos.some((t) => t.includes('{{nombre}}'))).toBe(false);
      expect(textos.some((t) => /buenos d[ií]as/i.test(t) && t.trim().endsWith(':'))).toBe(false);
    }
  });

  it('decodifica las entidades HTML a texto legible (tildes, ¿, ñ, %)', () => {
    const { html } = plantillaCargada('inicial');
    const textos = extraerParrafosEditables(html).map((x) => x.texto);
    // "Importar uniformes por cuenta propia toma entre 60 y 90 días..."
    expect(textos[0]).toContain('días');
    expect(textos[0]).toContain('producción');
    expect(textos[0]).not.toMatch(/&[a-z]+;/);
  });

  it('seguimiento_1 decodifica ¿ y % correctamente', () => {
    const { html } = plantillaCargada('seguimiento_1');
    const textos = extraerParrafosEditables(html).map((x) => x.texto);
    const conPregunta = textos.find((t) => t.includes('¿'));
    expect(conPregunta).toBeDefined();
    const conPorcentaje = textos.find((t) => t.includes('70'));
    expect(conPorcentaje).toContain('%');
  });

  it('colapsa la indentación del HTML fuente a espacio simple', () => {
    const { html } = plantillaCargada('inicial');
    const textos = extraerParrafosEditables(html).map((x) => x.texto);
    for (const t of textos) {
      expect(t).not.toMatch(/\n/);
      expect(t).not.toMatch(/ {2,}/);
      expect(t).toBe(t.trim());
    }
  });
});

describe('aplicarParrafosEditados', () => {
  it('reemplaza los párrafos editables en el mismo orden, sin tocar el resto del armazón', () => {
    const { html } = plantillaCargada('inicial');
    const nuevos = ['Primer párrafo nuevo.', 'Segundo párrafo nuevo.', 'Tercer párrafo nuevo.'];
    const resultado = aplicarParrafosEditados(html, nuevos);

    for (const texto of nuevos) expect(resultado).toContain(texto);
    // El saludo sigue intacto -- con el marcador sin resolver, tal como
    // vino del disco.
    expect(resultado).toContain('Buenos d&iacute;as{{nombre}}:');
    // El armazón (botón, firma, pie) no cambió una letra.
    expect(resultado).toContain('Solicitar una cotizaci&oacute;n');
    expect(resultado).toContain('{{unsubscribe_url}}');
    expect(resultado).toContain('{{empresa}}');
    // Nada del <head>, las tablas ni los estilos en línea se tocó.
    expect(resultado).toContain('<!--[if mso]>');
    expect(resultado).toContain('display:none;max-height:0;overflow:hidden;mso-hide:all;');
  });

  it('un párrafo editado a vacío no rompe el HTML -- deja el <p></p> vacío, no desaparece la etiqueta', () => {
    const { html } = plantillaCargada('inicial');
    const resultado = aplicarParrafosEditados(html, ['', 'Segundo.', 'Tercero.']);
    expect(resultado).toMatch(/<p style="margin:0 0 18px 0;[^"]*">\s*<\/p>/);
  });

  it('menos textos que párrafos deja los que faltan con su texto ORIGINAL (nunca los borra)', () => {
    const { html } = plantillaCargada('inicial');
    const original = extraerParrafosEditables(html).map((p) => p.texto);
    const resultado = aplicarParrafosEditados(html, ['Sólo el primero cambió.']);
    expect(resultado).toContain('Sólo el primero cambió.');
    // El segundo y tercer párrafo siguen siendo el texto original de la
    // plantilla (verificado contra una porción reconocible, no el HTML
    // entero con entidades).
    expect(resultado).toContain('Mi nombre es Guillermo');
    expect(original[1]).toContain('Mi nombre es Guillermo');
  });

  it('escapa HTML del texto editado -- un intento de inyectar una etiqueta no cuela', () => {
    const { html } = plantillaCargada('inicial');
    const malicioso = '<a href="https://evil.example">hacé clic</a>';
    const resultado = aplicarParrafosEditados(html, [malicioso, 'x', 'y']);
    expect(resultado).not.toContain('<a href="https://evil.example">');
    expect(resultado).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;');
  });

  it('un salto de línea en el texto editado se vuelve <br>, no una etiqueta rota', () => {
    const { html } = plantillaCargada('inicial');
    const resultado = aplicarParrafosEditados(html, ['Línea uno.\nLínea dos.', 'x', 'y']);
    expect(resultado).toContain('Línea uno.<br>Línea dos.');
  });

  it('nunca toca el párrafo del saludo, aunque se le pase un texto para esa posición', () => {
    const { html } = plantillaCargada('inicial');
    // Si `aplicarParrafosEditados` contara el saludo como editable por
    // error, el primer texto de este arreglo terminaría reemplazando el
    // saludo en vez del primer párrafo de cuerpo.
    const resultado = aplicarParrafosEditados(html, ['NO debería aparecer en el saludo', 'x', 'y']);
    expect(resultado).toContain('Buenos d&iacute;as{{nombre}}:');
    expect(resultado).not.toMatch(/Buenos d&iacute;as[^:]*NO debería/);
  });

  it.each(PLANTILLAS)(
    '%s: el resultado sigue siendo una plantilla válida para renderizarPlantilla',
    (plantilla) => {
      const { html } = plantillaCargada(plantilla);
      const cantidad = contarParrafosEditables(html);
      const editado = aplicarParrafosEditados(html, Array.from({ length: cantidad }, (_, i) => `Párrafo ${i}.`));
      const renderizado = renderizarPlantilla(editado, {
        nombreCrm: 'Ana Solano',
        unsubscribeUrl: 'https://luxeessentialscr.com/baja?t=abc.def',
      });
      expect(renderizado).toContain('Ana');
      expect(renderizado).toContain('https://luxeessentialscr.com/baja?t=abc.def');
      expect(renderizado).not.toContain('{{nombre}}');
      expect(renderizado).not.toContain('{{empresa}}');
      expect(renderizado).not.toContain('{{unsubscribe_url}}');
    },
  );
});
