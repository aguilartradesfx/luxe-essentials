// @vitest-environment node
//
// Ronda de correcciones 1: bajo el entorno por defecto de este archivo
// (`jsdom`, fijado en vitest.config.ts para el resto de la suite),
// `renderToBuffer` produce un flujo de contenido con una cabecera deflate
// inválida (`78 fd fd 5c` en vez de `78 9c dd 5c`): un PDF que empieza con
// `%PDF-` y pesa más de 1000 bytes, pero que MuPDF y CoreGraphics renderizan
// en blanco. Las 4 pruebas originales pasaban igual porque sólo miraban la
// firma y el tamaño del buffer — nunca el contenido. Este archivo corre bajo
// Node real (sin el DOM simulado de jsdom) precisamente para que el PDF que
// se valida acá sea el mismo que ve un hotel de verdad.
import { describe, it, expect } from 'vitest';
import { PDFParse } from 'pdf-parse';
// Sin la capa de alto nivel de pdf-parse: para el hallazgo del nombre largo
// sin espacios (ronda de correcciones 1) hace falta la posición de cada
// fragmento de texto en la página, no sólo el texto. pdfjs-dist es la
// dependencia que pdf-parse ya usa por debajo.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { renderizarCotizacion } from '@/lib/cotizador/documento';
import type { Cotizacion } from '@/lib/cotizador/tipos';

const cotizacion: Cotizacion = {
  lineas: [
    {
      skuId: 'set-600-king', nombre: 'Set de 600 hilos king',
      contenido: ['1 cubrecama', '1 sábana', '2 sobrefundas'],
      cantidad: 16, precioLista: 90000, descuentoPct: 10,
      precioUnitario: 81000, subtotal: 1296000, grupo: 'sets-cama',
      motivo: '16 sets en Sets de cama → 10%',
    },
  ],
  subtotal: 1296000, ahorro: 144000, tasaIva: 0.13, iva: 168480,
  total: 1464480, bordadoEspecial: false,
};

const base = {
  numero: 'COT-2026-0001',
  cotizacion,
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
  emitida: new Date('2026-08-27T12:00:00Z'),
  vence: new Date('2026-09-26T12:00:00Z'),
};

// Extrae el texto de un PDF ya generado, página por página. Es la única
// forma real de saber qué ve el cliente: un buffer que empieza con `%PDF-`
// puede perfectamente estar corrupto por dentro (ver el comentario de
// arriba).
async function extraerTexto(buf: Buffer) {
  const parser = new PDFParse({ data: buf });
  const resultado = await parser.getText();
  await parser.destroy();
  return resultado;
}

describe('renderizarCotizacion', () => {
  it('produce un PDF válido', async () => {
    const buf = await renderizarCotizacion(base);
    expect(Buffer.isBuffer(buf)).toBe(true);
    // Todo PDF empieza con esta firma. Sin ella no es un PDF, sea lo que sea.
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('no falla con una cotización de muchas líneas', async () => {
    const muchas = {
      ...base,
      cotizacion: {
        ...cotizacion,
        lineas: Array.from({ length: 40 }, (_, i) => ({
          ...cotizacion.lineas[0], skuId: `sku-${i}`, nombre: `Producto ${i}`,
        })),
      },
    };
    const buf = await renderizarCotizacion(muchas);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('no falla cuando el cliente está exento de IVA', async () => {
    const exento = {
      ...base,
      cotizacion: { ...cotizacion, tasaIva: 0, iva: 0, total: cotizacion.subtotal },
    };
    const buf = await renderizarCotizacion(exento);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('no falla sin empresa ni contenido de set', async () => {
    const minimo = {
      ...base,
      cliente: { nombre: 'Ana Pérez', email: 'ana@hotel.com' },
      cotizacion: {
        ...cotizacion,
        lineas: [{ ...cotizacion.lineas[0], contenido: undefined, descuentoPct: 0 }],
      },
    };
    const buf = await renderizarCotizacion(minimo);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('el monto total aparece formateado, y el símbolo ₡ no sale roto', async () => {
    const buf = await renderizarCotizacion(base);
    const { text } = await extraerTexto(buf);
    expect(text).toContain('₡1.464.480');
    // Es la regresión exacta que ya mordió en el desarrollo: con las fuentes
    // estándar de PDF, react-pdf reemplaza en silencio el ₡ por "¡" en todo
    // el documento. Un "¡" en cualquier parte del texto es la señal.
    expect(text).not.toContain('¡');
  });

  it('el desglose del set aparece en el texto, no sólo el nombre', async () => {
    const buf = await renderizarCotizacion(base);
    const { text } = await extraerTexto(buf);
    expect(text).toContain('Incluye: 1 cubrecama, 1 sábana, 2 sobrefundas.');
  });

  it('"Válida hasta" aparece en el texto', async () => {
    const buf = await renderizarCotizacion(base);
    const { text } = await extraerTexto(buf);
    expect(text).toContain('Válida hasta');
  });

  // Regresión: ronda de correcciones 1 sobre la Tarea 4. `Intl.DateTimeFormat
  // ('es-CR', {month:'long'})` da "septiembre", nunca "setiembre" — la forma
  // que se usa en Costa Rica. `lib/cotizador/fechas.ts` lo corrige a mano;
  // esta prueba comprueba que el PDF (no sólo el correo) realmente lo usa.
  it('la fecha usa "setiembre", no "septiembre"', async () => {
    const buf = await renderizarCotizacion(base); // vence: 2026-09-26
    const { text } = await extraerTexto(buf);
    expect(text).toContain('setiembre');
    expect(text).not.toContain('septiembre');
  });

  it('no menciona ningún método de pago', async () => {
    // Requisito escrito del cliente: el vendedor coordina el cobro aparte.
    // Se prueba sobre la cotización con más superficie de texto (muchas
    // líneas + bordado especial + cliente exento) para que un mensaje de
    // pago agregado a cualquier rama condicional del documento no se escape.
    const amplia = {
      ...base,
      cotizacion: {
        ...cotizacion,
        tasaIva: 0,
        iva: 0,
        total: cotizacion.subtotal,
        bordadoEspecial: true,
        lineas: Array.from({ length: 5 }, (_, i) => ({
          ...cotizacion.lineas[0], skuId: `sku-${i}`, nombre: `Producto ${i}`,
        })),
      },
    };
    const buf = await renderizarCotizacion(amplia);
    const { text } = await extraerTexto(buf);
    expect(text.toLowerCase()).not.toMatch(
      /pago|tarjeta|efectivo|transferencia|dep[oó]sito|cheque|sinpe|contado|cr[eé]dito/,
    );
  });

  it('el bloque de Total/Subtotal/IVA nunca se parte entre páginas, de 1 a 30 líneas', async () => {
    // Hallazgo crítico de la ronda de correcciones 1: sin `wrap={false}` en
    // el bloque de totales, con cotizaciones de un tamaño de línea normal
    // (¡7 líneas ya alcanza!) la caja del Total podía quedar en una página y
    // "Subtotal"/"+ IVA" en la siguiente, flotando bajo un encabezado de
    // tabla vacío. El revisor barrió de 1 a 30 líneas y encontró 10 de 30
    // conteos rotos. Se repite el mismo barrido acá.
    const conteosRotos: number[] = [];

    for (let n = 1; n <= 30; n++) {
      const escalada: Cotizacion = {
        ...cotizacion,
        lineas: Array.from({ length: n }, (_, i) => ({
          ...cotizacion.lineas[0], skuId: `sku-${i}`, nombre: `Producto ${i}`,
        })),
        subtotal: cotizacion.subtotal * n,
        ahorro: cotizacion.ahorro * n,
        iva: cotizacion.iva * n,
        total: cotizacion.total * n,
      };
      const buf = await renderizarCotizacion({ ...base, cotizacion: escalada });
      const { pages } = await extraerTexto(buf);

      const paginaTotal = pages.find((p) => /\bTotal\b/.test(p.text));
      const okMismaPagina =
        !!paginaTotal &&
        /Subtotal/.test(paginaTotal.text) &&
        /IVA/.test(paginaTotal.text);

      if (!okMismaPagina) conteosRotos.push(n);
    }

    expect(conteosRotos, `conteos de línea con el bloque de totales partido: ${conteosRotos.join(', ')}`).toEqual([]);
  });

  it('un nombre de producto sin espacios no invade las columnas de cantidad y precio', async () => {
    // Hallazgo de la ronda de correcciones 1: con la hifenación apagada del
    // todo, un token sin espacios más largo que la columna (un SKU o código
    // pegado) no tenía dónde partirse y el motor de layout lo dejaba
    // desbordar sobre las columnas vecinas — tapando la cantidad y el
    // precio. 90 caracteres, muy por encima de cualquier nombre real del
    // catálogo.
    const tokenLargo = 'X'.repeat(90);
    const conTokenLargo = {
      ...base,
      cotizacion: {
        ...cotizacion,
        lineas: [{ ...cotizacion.lineas[0], nombre: tokenLargo, contenido: undefined }],
      },
    };
    const buf = await renderizarCotizacion(conTokenLargo);

    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const pagina = await doc.getPage(1);
    const contenido = await pagina.getTextContent();
    type Item = { str: string; transform: number[]; width: number };
    const items = contenido.items as Item[];

    // La cantidad ("16") vive en la columna vecina: es el punto de
    // referencia real de dónde empieza esa columna en la página renderizada,
    // en vez de un número de píxeles copiado a mano del estilo.
    const itemCantidad = items.find((it) => it.str.trim() === '16');
    expect(itemCantidad).toBeDefined();
    const inicioColumnaCantidad = itemCantidad!.transform[4];

    const fragmentosDelNombre = items.filter((it) => /^X+-?$/.test(it.str));
    expect(fragmentosDelNombre.length).toBeGreaterThan(0);
    for (const fragmento of fragmentosDelNombre) {
      const finFragmento = fragmento.transform[4] + fragmento.width;
      expect(finFragmento).toBeLessThan(inicioColumnaCantidad);
    }
  });
});
