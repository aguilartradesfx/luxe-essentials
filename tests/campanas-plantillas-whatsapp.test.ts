// tests/campanas-plantillas-whatsapp.test.ts
//
// Ancla el botón directo a WhatsApp que ahora conviven con el botón a
// cotización en inicial/seguimiento_1/seguimiento_2, y su ausencia
// deliberada en seguimiento_3 (la de cierre) -- contra las plantillas
// REALES (no un fixture a mano, como tests/campanas-plantillas.test.ts).
// Sin esta prueba, nada detecta si alguien cambia el número, rompe el
// mensaje precargado, o le agrega un botón a la plantilla de cierre por
// error.
import { describe, it, expect } from 'vitest';
import { plantillaCargada } from '@/lib/campanas/plantillas';

const NUMERO_WHATSAPP = '50661402511';

// El texto EXACTO (ya percent-encoded) del mensaje precargado por
// plantilla -- se ancla el string completo, no sólo "contiene wa.me", para
// que un mutante que cambie una palabra del mensaje, o que rompa el
// encoding de la tilde, falle la prueba.
const WHATSAPP_HREF: Record<'inicial' | 'seguimiento_1' | 'seguimiento_2', string> = {
  inicial:
    'https://wa.me/50661402511?text=Hola%2C%20quisiera%20una%20cotizaci%C3%B3n%20de%20uniformes%20para%20mi%20empresa.',
  seguimiento_1:
    'https://wa.me/50661402511?text=Hola%2C%20quisiera%20una%20cotizaci%C3%B3n%20de%20referencia%20para%20uniformes.',
  seguimiento_2:
    'https://wa.me/50661402511?text=Hola%2C%20quisiera%20empezar%20por%20un%20puesto%20para%20cotizar%20uniformes.',
};

// El botón "principal" original de cada plantilla -- el que ya existía
// antes de esta tarea. Tiene que sobrevivir intacto: dos botones, no un
// reemplazo.
const BOTON_PRINCIPAL: Record<'inicial' | 'seguimiento_1' | 'seguimiento_2', string> = {
  inicial: 'Solicitar una cotizaci&oacute;n',
  seguimiento_1: 'Pedir la cotizaci&oacute;n de referencia',
  seguimiento_2: 'Empezar por un puesto',
};

const PLANTILLAS_CON_CTA = ['inicial', 'seguimiento_1', 'seguimiento_2'] as const;

describe('botón directo a WhatsApp, en las tres plantillas que llevan CTA', () => {
  it.each(PLANTILLAS_CON_CTA)('%s: el href de WhatsApp es exactamente el esperado (número + mensaje precargado)', (plantilla) => {
    const { html } = plantillaCargada(plantilla);
    expect(html).toContain(`href="${WHATSAPP_HREF[plantilla]}"`);
  });

  it.each(PLANTILLAS_CON_CTA)('%s: el número de WhatsApp del botón es el mismo que ya usa la firma (+506 6140 2511)', (plantilla) => {
    const { html } = plantillaCargada(plantilla);
    // La firma de las cuatro plantillas ya enlaza a wa.me/50661402511 --
    // este assert falla si el botón nuevo usara un número distinto al de
    // la firma existente.
    const enlacesWaMe = html.match(/https:\/\/wa\.me\/(\d+)/g) ?? [];
    expect(enlacesWaMe.length).toBeGreaterThanOrEqual(2); // firma + botón
    for (const enlace of enlacesWaMe) {
      expect(enlace).toBe(`https://wa.me/${NUMERO_WHATSAPP}`);
    }
  });

  it.each(PLANTILLAS_CON_CTA)('%s: el botón de WhatsApp dice "Escribir por WhatsApp"', (plantilla) => {
    const { html } = plantillaCargada(plantilla);
    expect(html).toContain('Escribir por WhatsApp');
  });

  it.each(PLANTILLAS_CON_CTA)('%s: el botón original (a cotización) sigue intacto -- son DOS botones, no un reemplazo', (plantilla) => {
    const { html } = plantillaCargada(plantilla);
    expect(html).toContain(BOTON_PRINCIPAL[plantilla]);
    expect(html).toContain('href="https://www.luxeessentialscr.com/#cotizacion"');
  });

  it.each(PLANTILLAS_CON_CTA)('%s: los dos botones usan class="stack" para no apilarse mal en móvil', (plantilla) => {
    const { html } = plantillaCargada(plantilla);
    // Se cuentan las etiquetas <td class="stack" ...> DESDE el comentario
    // "<!-- Botones" en adelante (no una búsqueda de texto suelta, para no
    // confundir la palabra dentro de un comentario con el atributo real) --
    // si alguien quita el atributo de cualquiera de los dos <td> que
    // envuelven un botón, el conteo baja de 2.
    const inicioBotones = html.indexOf('<!-- Botones');
    expect(inicioBotones).toBeGreaterThan(-1);
    const bloqueBotones = html.slice(inicioBotones);
    const apiladosEnEsteBloque = (bloqueBotones.match(/<td class="stack"/g) ?? []).length;
    expect(apiladosEnEsteBloque).toBe(2);
  });
});

describe('seguimiento_3 (la de cierre): sin botón de WhatsApp, a propósito', () => {
  it('no tiene ningún botón de WhatsApp', () => {
    const { html } = plantillaCargada('seguimiento_3');
    expect(html).not.toContain('wa.me/50661402511?text=');
    expect(html).not.toContain('Escribir por WhatsApp');
  });

  it('no tiene el botón a cotización (ni ningún enlace a #cotizacion)', () => {
    const { html } = plantillaCargada('seguimiento_3');
    expect(html).not.toContain('#cotizacion');
  });

  // El único wa.me permitido en seguimiento_3 es el de la firma (idéntico
  // en las cuatro plantillas) -- uno solo, no dos.
  it('el único enlace de WhatsApp que le queda es el de la firma', () => {
    const { html } = plantillaCargada('seguimiento_3');
    const enlaces = html.match(/https:\/\/wa\.me\/\d+/g) ?? [];
    expect(enlaces).toEqual(['https://wa.me/50661402511']);
  });
});
