// Prepara el HTML de un correo AJENO para mostrarlo dentro del panel, en la
// ventana de «Correos enviados». Código de navegador (usa DOMParser).
//
// El correo que se muestra es el que recibió una persona real, y trae el
// enlace que da de baja a esa empresa: si alguien hace clic acá, daría de
// baja a un cliente de verdad. Por eso NINGÚN enlace de esta vista puede
// navegar, y no se deja eso librado a que nadie haga clic por curiosidad.
// Hay tres capas, cada una suficiente por sí sola para lo que cubre:
//
//   1. Esta función quita del documento todo lo que puede llevar a otra
//      parte o ejecutar algo: `href` (también `xlink:href`), `action`,
//      `formaction`, los `on...`, y los elementos `script`, `iframe`,
//      `object`, `embed`, `base`, `link`, `meta http-equiv`... Se hace sobre
//      un documento ya interpretado (DOMParser, que no ejecuta nada ni carga
//      imágenes), no con expresiones regulares sobre el texto: un `<A
//      HREF = x>` raro o un `href` escrito con entidades también cae.
//   2. Una política de contenido dentro del propio documento: sin scripts,
//      sin marcos, sin formularios, imágenes y estilos sólo de lo permitido.
//   3. El marco que lo muestra (`<iframe sandbox="">` en
//      app/cotizador/VentanaCorreoEnviado.tsx), sin NINGÚN permiso: ni
//      scripts, ni navegar la página de arriba, ni abrir ventanas, ni
//      formularios, y con origen aislado: sus estilos no tocan los del panel
//      ni puede leer nada de él.
export const POLITICA_VISTA_PREVIA = [
  "default-src 'none'",
  "img-src https: data:",
  "style-src 'unsafe-inline'",
  "font-src https: data:",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const ELEMENTOS_FUERA = ['script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'link', 'form', 'template'];

// Los enlaces pierden su destino pero conservan el aspecto de enlace (los
// `a` sin `href` el navegador ya no los pinta azules ni subrayados). `:where`
// deja el aspecto con especificidad cero: cualquier estilo del propio correo
// lo pisa.
const ESTILO_BASE =
  ':where(a[data-sin-destino]){color:#1a56db;text-decoration:underline;cursor:default}' +
  'img{max-width:100%;height:auto}';

function esAtributoDeDestino(nombre: string): boolean {
  const n = nombre.toLowerCase();
  return n === 'href' || n.endsWith(':href') || n === 'action' || n === 'formaction' || n === 'ping' || n === 'srcdoc' || n.startsWith('on');
}

export function prepararVistaPrevia(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  for (const el of Array.from(doc.querySelectorAll(ELEMENTOS_FUERA.join(',')))) el.remove();
  for (const el of Array.from(doc.querySelectorAll('meta[http-equiv]'))) el.remove();
  for (const el of Array.from(doc.querySelectorAll('area'))) el.remove();

  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const atributo of Array.from(el.attributes)) {
      if (!esAtributoDeDestino(atributo.name)) continue;
      el.removeAttribute(atributo.name);
      if (el.localName === 'a') el.setAttribute('data-sin-destino', '');
    }
  }

  const politica = doc.createElement('meta');
  politica.setAttribute('http-equiv', 'Content-Security-Policy');
  politica.setAttribute('content', POLITICA_VISTA_PREVIA);
  const estilo = doc.createElement('style');
  estilo.textContent = ESTILO_BASE;
  // Primero en el <head>: la política rige para todo lo que viene después, y
  // el estilo base queda antes que los del correo (que lo pisan).
  doc.head.prepend(politica, estilo);

  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
