import { describe, it, expect } from 'vitest';
import { POLITICA_VISTA_PREVIA, prepararVistaPrevia } from '@/lib/campanas/vista-previa-correo';

// El correo que se muestra trae el enlace de baja REAL de un cliente. Estas
// pruebas leen el resultado como lo leeria el navegador (se vuelve a
// interpretar), no con busquedas de texto: lo que importa es que no quede
// ningun atributo que lleve a otra parte o ejecute algo.
const BAJA = 'https://luxeessentialscr.com/baja?t=YW5hQGhvdGVsLmNy.firma';

function reparsear(html: string) {
  return new DOMParser().parseFromString(prepararVistaPrevia(html), 'text/html');
}
function atributosPeligrosos(doc: Document): string[] {
  const malos: string[] = [];
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      if (n === 'href' || n.endsWith(':href') || n === 'action' || n === 'formaction' || n.startsWith('on') || n === 'srcdoc')
        malos.push(`${el.localName}[${a.name}]`);
    }
  }
  return malos;
}

describe('prepararVistaPrevia -- ningun enlace navega', () => {
  it('el enlace de baja real pierde su destino: no queda en ningun atributo', () => {
    const out = prepararVistaPrevia(`<html><body><a href="${BAJA}">Darme de baja</a></body></html>`);
    expect(out).not.toContain('baja?t=');
    const a = reparsear(`<a href="${BAJA}">Darme de baja</a>`).querySelector('a')!;
    expect(a.hasAttribute('href')).toBe(false);
    expect(a.textContent).toBe('Darme de baja');
  });

  it.each([
    ['comillas simples', `<a href='${BAJA}'>x</a>`],
    ['sin comillas', `<a href=${BAJA}>x</a>`],
    ['mayusculas y espacios', `<A HREF = "${BAJA}">x</A>`],
    ['salto de linea antes del atributo', `<a\nhref="${BAJA}">x</a>`],
    ['con entidades', `<a href="&#104;ttps://luxeessentialscr.com/baja?t=abc">x</a>`],
    ['javascript:', `<a href="javascript:alert(1)">x</a>`],
    ['con target', `<a href="${BAJA}" target="_top">x</a>`],
    ['mapa de imagen', `<map name="m"><area href="${BAJA}" shape="rect" coords="0,0,9,9"></map>`],
    ['enlace dentro de svg', `<svg><a xlink:href="${BAJA}"><text>x</text></a></svg>`],
    ['enlace svg moderno', `<svg><a href="${BAJA}"><text>x</text></a></svg>`],
    ['formulario con action', `<form action="${BAJA}" method="post"><button formaction="${BAJA}">x</button></form>`],
    ['boton con formaction', `<button formaction="${BAJA}">x</button>`],
    ['ping', `<a ping="${BAJA}" href="${BAJA}">x</a>`],
  ])('%s: sin atributos de destino', (_n, html) => {
    const doc = reparsear(`<html><body>${html}</body></html>`);
    expect(atributosPeligrosos(doc)).toEqual([]);
    expect(prepararVistaPrevia(html)).not.toMatch(/baja\?t=|javascript:/i);
  });

  it('quita lo que ejecutaria algo o llevaria a otra parte', () => {
    const doc = reparsear(
      `<html><head><meta http-equiv="refresh" content="0;url=${BAJA}"><base href="${BAJA}"><link rel="stylesheet" href="https://x.cr/a.css"><script>alert(1)</script></head>` +
        `<body onload="x()"><img src="https://luxeessentialscr.com/a.png" onerror="alert(1)"><p onclick="x()">hola</p>` +
        `<iframe src="${BAJA}"></iframe><object data="${BAJA}"></object><embed src="${BAJA}"><script src="https://x.cr/a.js"></script></body></html>`,
    );
    for (const sel of ['script', 'iframe', 'object', 'embed', 'base', 'link', 'meta[http-equiv="refresh"]'])
      expect(doc.querySelector(sel), sel).toBeNull();
    expect(atributosPeligrosos(doc)).toEqual([]);
    expect(doc.querySelector('p')!.textContent).toBe('hola');
  });

  it('lleva una politica de contenido PRIMERA en el head, sin scripts ni marcos ni formularios', () => {
    const doc = reparsear('<html><head><title>x</title></head><body>hola</body></html>');
    const primero = doc.head.firstElementChild!;
    expect(primero.localName).toBe('meta');
    expect(primero.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(primero.getAttribute('content')).toBe(POLITICA_VISTA_PREVIA);
    expect(POLITICA_VISTA_PREVIA).toContain("default-src 'none'");
    expect(POLITICA_VISTA_PREVIA).toContain("form-action 'none'");
    expect(POLITICA_VISTA_PREVIA).not.toMatch(/script-src|frame-src|unsafe-eval/);
  });
});

describe('prepararVistaPrevia -- conserva el correo', () => {
  it('deja el texto, los estilos propios y las imagenes tal cual', () => {
    const doc = reparsear(
      `<html><head><style>.t{color:#c00}</style></head><body style="background:#eee"><p class="t" style="margin:0">Hola, Ana</p><img src="https://luxeessentialscr.com/a.png" alt="Logo"></body></html>`,
    );
    expect(doc.querySelector('style:not([data-x])')).not.toBeNull();
    expect(doc.body.getAttribute('style')).toBe('background:#eee');
    expect(doc.querySelector('p')!.getAttribute('style')).toBe('margin:0');
    expect(doc.querySelector('p')!.textContent).toBe('Hola, Ana');
    expect(doc.querySelector('img')!.getAttribute('src')).toBe('https://luxeessentialscr.com/a.png');
    expect(Array.from(doc.querySelectorAll('style')).some((s) => s.textContent!.includes('.t{color:#c00}'))).toBe(true);
  });

  it('un enlace sin destino se sigue viendo como enlace', () => {
    const doc = reparsear(`<a href="${BAJA}">baja</a>`);
    expect(doc.querySelector('a')!.hasAttribute('data-sin-destino')).toBe(true);
    expect(doc.head.textContent).toContain('a[data-sin-destino]');
  });

  it('un fragmento sin <html> ni <body> tambien sale como documento completo', () => {
    const out = prepararVistaPrevia('<p>solo un parrafo</p>');
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('solo un parrafo');
  });
});
