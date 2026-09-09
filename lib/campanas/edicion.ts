import 'server-only';

// Lo único que la pantalla de campañas (parte 2) puede tocar de una
// plantilla: los párrafos del cuerpo, nunca el armazón. Este módulo hace
// las dos mitades de ese contrato -- sacar los párrafos editables de un
// `html` (para que la pantalla los muestre en un textarea por párrafo) y
// devolverlos ya editados a su lugar (para que `crearCampana` reciba el
// `html` final) -- sin que en ningún momento la pantalla vea, o pueda
// mandar, una etiqueta HTML.
//
// Cómo se reconoce un párrafo editable: las cuatro plantillas
// (lib/campanas/plantillas/*.html) usan la MISMA firma de estilo en línea
// para cada `<p>` del cuerpo -- `font-family:Arial,Helvetica,sans-serif;
// font-size:16px;line-height:1.65;color:#26292E;`, con sólo el margen
// inferior variando entre párrafos (18, 22, 24, 26 ó 30 px según la
// plantilla) -- y en NINGUNA otra parte del armazón (comparativa de
// tiempos, proceso numerado, cita destacada, botón, firma, pie) aparece esa
// firma. Es una firma de ESTILO, no de posición ni de plantilla: no hace
// falta saber cuántos párrafos tiene cada una ni en qué orden -- alcanza
// con reconocer la marca que el propio autor del HTML les puso a los
// párrafos de texto libre.
//
// El saludo ("Buenos días{{nombre}}:") y, en seguimiento_3, la despedida
// ("Gracias por el tiempo{{nombre}}. Un gusto.") usan esa MISMA firma de
// estilo -- son párrafos de cuerpo, visualmente -- pero no son texto libre:
// llevan el marcador `{{nombre}}` que `lib/campanas/marcadores.ts` resuelve
// con su propia coma y su propio espacio (ver el comentario de
// `marcadorNombre` ahí). Editarlos rompería ese contrato ("Buenos días,
// Ana, hola:" si alguien agrega texto alrededor del marcador). Por eso se
// excluyen de lo editable con la misma regla en los dos sentidos de este
// módulo: un párrafo cuyo interior contiene `{{nombre}}` no se ofrece para
// editar, y tampoco se toca al reinyectar.
const RE_PARRAFO_CUERPO =
  /<p style="margin:0 0 \d+px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1\.65;color:#26292E;">([\s\S]*?)<\/p>/g;

function esEditable(interiorCrudo: string): boolean {
  return !interiorCrudo.includes('{{nombre}}');
}

// Las entidades HTML que de verdad aparecen en el texto libre de las cuatro
// plantillas (ver el grep que las inventarió: aacute, eacute, iacute,
// iquest, nbsp, ndash, ntilde, oacute, uacute) más el resto del alfabeto
// acentuado en español y las entidades genéricas (`amp`, `lt`, `gt`,
// `quot`) por si un párrafo editado en el pasado las reintrodujera. NO es
// una lista exhaustiva de HTML -- es la lista cerrada y verificable que
// necesita ESTE juego de plantillas; una entidad fuera de esta lista queda
// tal cual (sin decodificar), visible en el textarea, en vez de perderse en
// silencio.
const ENTIDADES_HTML: Record<string, string> = {
  aacute: 'á', Aacute: 'Á',
  eacute: 'é', Eacute: 'É',
  iacute: 'í', Iacute: 'Í',
  oacute: 'ó', Oacute: 'Ó',
  uacute: 'ú', Uacute: 'Ú',
  uuml: 'ü', Uuml: 'Ü',
  ntilde: 'ñ', Ntilde: 'Ñ',
  iquest: '¿', iexcl: '¡',
  ndash: '–', mdash: '—',
  middot: '·',
  nbsp: ' ',
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

// El viaje de vuelta de `escaparHtml` (lib/campanas/marcadores.ts) más las
// entidades con nombre de la tabla de arriba y las numéricas
// (`&#8203;`, `&#39;`...). Convierte el HTML fuente en el texto plano que
// alguien puede leer y editar en un textarea -- "días", no "d&iacute;as".
function decodificarEntidades(html: string): string {
  return html
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (coincidencia: string, nombre: string) => ENTIDADES_HTML[nombre] ?? coincidencia);
}

// Mismo criterio, y la MISMA implementación, que `escaparHtml` en
// lib/campanas/marcadores.ts (que no la exporta -- se duplica acá por el
// mismo motivo que ese archivo documenta para su propia duplicación con
// lib/cotizador/correo-invitacion.ts: no vale la pena cruzar el módulo por
// cuatro líneas). Necesaria acá porque el texto que vuelve de un párrafo
// editado sale de un `<textarea>` que cualquiera con acceso a esta pantalla
// puede escribir -- sin escapar, un párrafo con `<a href="...">` colaría un
// enlace de phishing en un correo que sale a miles de contactos a la vez.
function escaparHtml(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Recorta espacio de sobra (la indentación del HTML fuente) y colapsa
// saltos de línea internos a un solo espacio -- cada párrafo editable es,
// visualmente, UN bloque de texto corrido; los saltos de línea que alguien
// meta al editar se tratan aparte, como separadores de línea explícitos
// (ver `construirInterior`, más abajo), no como el whitespace decorativo
// del HTML fuente.
function limpiarEspacio(texto: string): string {
  return texto.replace(/\s+/g, ' ').trim();
}

export type ParrafoEditable = {
  // Texto plano, legible, listo para un `<textarea>` -- entidades
  // decodificadas, indentación del HTML fuente descartada.
  texto: string;
};

// Los párrafos de cuerpo de una plantilla, en el orden en que aparecen en
// el `html`. `crearCampana`/`previsualizar` (rutas de campanas) esperan que
// la pantalla les devuelva exactamente esta misma cantidad de textos, en
// este mismo orden -- es el contrato con `aplicarParrafosEditados`, abajo.
export function extraerParrafosEditables(html: string): ParrafoEditable[] {
  const parrafos: ParrafoEditable[] = [];
  // `RegExp` con `g` lleva estado en `lastIndex`: esta función se llama una
  // vez por `html`, pero clonar el patrón evita que dos llamadas
  // concurrentes (o un `while` que no agota el `exec`) pisen el cursor de
  // la otra.
  const patron = new RegExp(RE_PARRAFO_CUERPO.source, RE_PARRAFO_CUERPO.flags);
  let coincidencia: RegExpExecArray | null;
  while ((coincidencia = patron.exec(html)) !== null) {
    const interiorCrudo = coincidencia[1];
    if (!esEditable(interiorCrudo)) continue;
    parrafos.push({ texto: limpiarEspacio(decodificarEntidades(interiorCrudo)) });
  }
  return parrafos;
}

// Cuántos párrafos editables tiene una plantilla -- lo que la ruta de
// crear/previsualizar valida contra el arreglo de textos que manda la
// pantalla, antes de reinyectar nada (ver `aplicarParrafosEditados`).
export function contarParrafosEditables(html: string): number {
  return extraerParrafosEditables(html).length;
}

// Un salto de línea que alguien mete al editar se vuelve un `<br>` -- no
// hay forma de pedir un párrafo HTML nuevo desde un textarea plano, así
// que la única forma de partir una línea es esta. `escaparHtml` corre
// LÍNEA por línea, antes de unir con `<br>`, para que un `<br>` real jamás
// pueda colarse por el texto de alguien (el que junta las líneas es el
// literal de este código, no algo que el texto editado pueda producir).
function construirInterior(texto: string): string {
  return texto
    .split(/\r?\n/)
    .map((linea) => escaparHtml(linea))
    .join('<br>');
}

// La otra mitad del contrato: vuelve a poner los textos editados en el
// `html` original, en el mismo orden en que `extraerParrafosEditables` los
// sacó. El saludo y (en seguimiento_3) la despedida -- los párrafos con
// `{{nombre}}` -- NUNCA se tocan, sin importar qué traiga `textos`: se
// saltan en el conteo (mismo criterio que la extracción) y su HTML original
// se devuelve intacto.
//
// Si `textos` trae menos entradas que párrafos editables, los que sobran
// quedan con su texto ORIGINAL (no vacíos) -- un `undefined` es "no lo
// toques", nunca "bórralo". La ruta que llama a esto (crear/previsualizar)
// igual valida el conteo antes de llegar acá (`contarParrafosEditables`) y
// rechaza un desajuste con un 400 explícito -- esto es la segunda guarda,
// no la primera.
export function aplicarParrafosEditados(html: string, textos: readonly string[]): string {
  let indice = 0;
  return html.replace(RE_PARRAFO_CUERPO, (coincidenciaCompleta: string, interiorCrudo: string) => {
    if (!esEditable(interiorCrudo)) return coincidenciaCompleta;
    const nuevoTexto = textos[indice];
    indice++;
    if (nuevoTexto === undefined) return coincidenciaCompleta;
    // Sólo se reemplaza el INTERIOR -- la etiqueta `<p style="...">` y su
    // cierre `</p>` (el armazón de este párrafo puntual) quedan tal cual.
    //
    // El segundo argumento va como FUNCIÓN, no como string: un string de
    // reemplazo interpreta patrones especiales de `String.replace` (`$&` =
    // el texto encontrado, `$'` = lo que sigue después del match, `$1`...) --
    // aunque el patrón de búsqueda (`interiorCrudo`) sea un string plano, no
    // una `RegExp`. Un párrafo editado que por casualidad contenga `$&`
    // reinyecta el texto ORIGINAL que se estaba reemplazando; uno con `$'`
    // cierra el `</p>` antes de tiempo y deja el resto del texto afuera de
    // la etiqueta. Una función de reemplazo no interpreta nada de eso: el
    // segundo argumento vuelve tal cual, sin importar qué caracteres traiga.
    return coincidenciaCompleta.replace(interiorCrudo, () => construirInterior(nuevoTexto));
  });
}
