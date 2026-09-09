import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

// La quinta opción de plantilla (encargo del dueño): pegar el HTML completo
// de un correo, en vez de elegir una de las cuatro fijas. Un HTML pegado a
// mano se manda a miles de empresas en nombre de Luxe -- este módulo es lo
// que blinda esa puerta, en tres partes:
//
//   1. `MARCADOR_BAJA` es obligatorio -- `validarMarcadorBaja` rechaza
//      cualquier HTML que no lo traiga, con un error explícito. Nunca se
//      inyecta el enlace de baja en un lugar arbitrario del HTML: mandar
//      correo masivo sin baja funcional hunde la reputación del dominio (el
//      mismo desde el que salen las cotizaciones) y es además una
//      obligación legal -- ver el comentario grande de esa función.
//   2. `sanitizarHtmlPersonalizado` quita lo que no debería viajar en un
//      correo (`<script>`, formularios, recursos externos que no sean
//      imágenes, atributos de evento en línea, esquemas `javascript:`) --
//      ver el comentario grande de esa función para el porqué de cada uno.
//   3. `firmarPrevisualizacion`/`previsualizacionValida`: la previsualización
//      pesa más que nunca con una plantilla propia -- es la única defensa
//      que queda contra un HTML roto o mal armado. `firmarPrevisualizacion`
//      es lo que hace que "hay que haberla visto" sea imposible de saltar,
//      no sólo un botón deshabilitado del lado del cliente -- ver el
//      comentario grande de esa función.

// El marcador que TODA plantilla personalizada tiene que traer. Las cuatro
// plantillas fijas también lo usan (lib/campanas/marcadores.ts) pero ahí es
// opcional en el sentido de que `renderizarPlantilla` no se queja si falta
// -- un archivo del propio repositorio, revisado una vez, que no lo trajera
// sería un bug que se nota enseguida. Un HTML pegado por cualquier
// superadmin, uno de miles de veces, no tiene esa red: por eso ACÁ, y sólo
// acá, la ausencia del marcador es un error que bloquea la campaña entera
// en vez de un correo que sale sin forma de darse de baja.
const MARCADOR_BAJA = '{{unsubscribe_url}}';

export type ResultadoValidarBaja = { ok: true } | { ok: false; error: string };

// Rechaza -- nunca inyecta en silencio -- un HTML personalizado que no trae
// el marcador de baja. "No lo inyectes en silencio en un lugar arbitrario:
// rechazalo y decí por qué, para que quien pega el HTML lo ponga donde
// corresponde" (pedido explícito): un enlace de baja insertado a ciegas por
// código -- al final del `<body>`, por ejemplo -- podría terminar invisible
// (dentro de un `<div style="display:none">` que el HTML pegado ya traía,
// fuera del área visible en un cliente de correo que recorta el mensaje) sin
// que nadie lo note hasta que ya se mandó a miles de destinatarios. Que la
// persona que pegó el HTML decida DÓNDE va el marcador es la única forma de
// que el enlace de baja quede donde de verdad se ve.
//
// Se llama SOBRE EL HTML YA SANEADO (después de `sanitizarHtmlPersonalizado`),
// nunca sobre el crudo -- si alguien puso el marcador sólo dentro de un
// `<script>` o un `<form>` que el saneo quita entero, el resultado saneado
// (que es el que de verdad se guarda y se manda) se queda sin el marcador, y
// eso tiene que rechazarse igual que si nunca lo hubiera puesto.
export function validarMarcadorBaja(htmlSaneado: string): ResultadoValidarBaja {
  if (htmlSaneado.includes(MARCADOR_BAJA)) return { ok: true };
  return {
    ok: false,
    error:
      `El HTML tiene que incluir el marcador ${MARCADOR_BAJA} en el enlace de baja ` +
      '(por ejemplo, dentro de un <a href="{{unsubscribe_url}}">Darse de baja</a> visible en el pie del ' +
      'correo). No se puede mandar una campaña sin él.',
  };
}

export type ResultadoSanitizar = { html: string; advertencias: string[] };

// Etiquetas que nunca deberían viajar en un correo -- ninguna de las dos
// categorías del encargo hace nada útil en un cliente de correo (los
// clientes las ignoran o las bloquean), pero un correo que las trae puntúa
// peor en los filtros de spam:
//   - `<script>`/`<form>`: ejecutable o interactivo -- ninguno de los dos
//     tiene sentido en un correo, y los dos son justo lo que un filtro de
//     spam mira con más sospecha.
//   - `<iframe>`/`<object>`/`<embed>`/`<video>`/`<audio>`/`<link>`/`<base>`:
//     "recursos externos que no sean imágenes" -- `<img>` se deja pasar
//     tal cual (a propósito: el pie de las cuatro plantillas fijas también
//     carga imágenes externas, y el encargo lo dice explícito -- "que no
//     sean imágenes"), pero estas siete etiquetas son las otras formas
//     estándar de traer un recurso externo a una página, y ninguna la
//     necesita un correo.
//   - `<meta http-equiv=...>`: la variante "meta refresh" es una
//     redirección -- funcionalmente parecida a un script, y un vector real
//     de phishing. El resto de `<meta>` (charset, viewport) es común e
//     inocuo en HTML de correo exportado de otras herramientas, así que
//     sólo se quita la variante con `http-equiv`, no la etiqueta entera.
const ETIQUETAS_CON_CONTENIDO = ['script', 'form', 'iframe', 'object', 'video', 'audio'] as const;
const ETIQUETAS_VACIAS = ['embed', 'link', 'base'] as const;

// Cuenta y quita todas las coincidencias de un patrón, en una sola pasada.
// Centraliza el conteo para la advertencia -- cada llamada a esta función es
// una línea del resumen que ve quien pegó el HTML.
function quitarConteo(html: string, patron: RegExp, etiqueta: (n: number) => string): { html: string; advertencia: string | null } {
  let n = 0;
  const resultado = html.replace(patron, () => {
    n++;
    return '';
  });
  return { html: resultado, advertencia: n > 0 ? etiqueta(n) : null };
}

// Atributos de evento en línea (`onclick`, `onerror`, `onload`...): sin
// esto, quitar `<script>` no alcanza -- `<img src=x onerror="...">` es
// JavaScript ejecutable sin ninguna etiqueta `<script>` de por medio, el
// mismo tipo de riesgo que el comentario de `escaparHtml`
// (lib/campanas/marcadores.ts) documenta como precedente real ("un nombre
// sin escapar coló una etiqueta <a href> de phishing"). Cubre valor entre
// comillas dobles, simples, y sin comillas.
const RE_ATRIBUTO_EVENTO = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

// Esquemas de URI ejecutables en `href`/`src`/`action`/`formaction`: la
// misma idea que los atributos de evento, por la otra puerta -- un
// `<a href="javascript:...">` corre código sin necesitar `<script>` ni
// `on*`. `data:text/html` se suma porque un navegador (o algún cliente de
// correo más permisivo) lo trata como una página HTML completa, con su
// propio `<script>` adentro si lo trae.
const RE_URI_EJECUTABLE =
  /(\s(?:href|src|action|formaction)\s*=\s*)(["'])\s*(?:javascript\s*:|vbscript\s*:|data:text\/html)[^"']*\2/gi;

// El saneo del HTML personalizado. Regex, no un parser de HTML de verdad --
// a propósito: "nada de dependencias nuevas, no instales un sanitizador"
// (advertencia explícita del encargo), y no hay ningún parser de HTML en
// las dependencias de producción de este repositorio (jsdom es de
// DESARROLLO, sólo para las pruebas -- ver package.json) como para tomarlo
// prestado sin agregar una dependencia nueva a producción. Es el mismo
// criterio pragmático que ya usa lib/campanas/edicion.ts para las cuatro
// plantillas fijas, llevado a un HTML que no se conoce de antemano.
//
// Límite conocido y aceptado: un sanitizador por regex sobre HTML arbitrario
// tiene formas de evadirse con HTML deliberadamente malformado (etiquetas
// partidas, anidadas de más, comentarios condicionales de Outlook que
// esconden markup). No es la defensa pensada contra un atacante externo --
// quien pega este HTML ya es un superadmin con acceso a esta pantalla, el
// mismo grupo chico y de confianza que ya administra el equipo y aprueba
// descuentos (ver el comentario grande de app/api/campanas/zonas/route.ts).
// El objetivo es atrapar lo más común -- un script de analítica o un
// formulario de newsletter copiados sin querer desde otra plantilla --, no
// resistir un intento deliberado de saltárselo.
export function sanitizarHtmlPersonalizado(htmlCrudo: string): ResultadoSanitizar {
  let html = htmlCrudo;
  const advertencias: string[] = [];

  for (const etiqueta of ETIQUETAS_CON_CONTENIDO) {
    const patron = new RegExp(`<${etiqueta}\\b[^>]*>[\\s\\S]*?<\\/${etiqueta}\\s*>`, 'gi');
    const r = quitarConteo(html, patron, (n) => `Se quitó ${n} etiqueta${n === 1 ? '' : 's'} <${etiqueta}>.`);
    html = r.html;
    if (r.advertencia) advertencias.push(r.advertencia);

    // Variante sin cierre (autocerrada o simplemente sin `</etiqueta>`,
    // HTML malformado que igual puede traer contenido peligroso en sus
    // atributos, `<script src="...">`, por ejemplo).
    const patronSuelto = new RegExp(`<${etiqueta}\\b[^>]*\\/?\\s*>`, 'gi');
    const r2 = quitarConteo(html, patronSuelto, (n) => `Se quitó ${n} etiqueta${n === 1 ? '' : 's'} <${etiqueta}> suelta${n === 1 ? '' : 's'} (sin cierre).`);
    html = r2.html;
    if (r2.advertencia) advertencias.push(r2.advertencia);
  }

  for (const etiqueta of ETIQUETAS_VACIAS) {
    const patron = new RegExp(`<${etiqueta}\\b[^>]*\\/?\\s*>`, 'gi');
    const r = quitarConteo(html, patron, (n) => `Se quitó ${n} etiqueta${n === 1 ? '' : 's'} <${etiqueta}>.`);
    html = r.html;
    if (r.advertencia) advertencias.push(r.advertencia);
  }

  const rMetaRefresh = quitarConteo(
    html,
    /<meta\b[^>]*http-equiv[^>]*>/gi,
    (n) => `Se quitó ${n} <meta http-equiv> (redirección).`,
  );
  html = rMetaRefresh.html;
  if (rMetaRefresh.advertencia) advertencias.push(rMetaRefresh.advertencia);

  const rEventos = quitarConteo(
    html,
    RE_ATRIBUTO_EVENTO,
    (n) => `Se quitaron ${n} atributo${n === 1 ? '' : 's'} de evento en línea (onclick, onerror...).`,
  );
  html = rEventos.html;
  if (rEventos.advertencia) advertencias.push(rEventos.advertencia);

  let nUri = 0;
  html = html.replace(RE_URI_EJECUTABLE, (_coincidencia, prefijo: string, comillas: string) => {
    nUri++;
    return `${prefijo}${comillas}#${comillas}`;
  });
  if (nUri > 0) advertencias.push(`Se neutralizaron ${nUri} enlace${nUri === 1 ? '' : 's'} con esquema javascript:/vbscript:/data:.`);

  return { html, advertencias };
}

function secreto(): string {
  // Reutiliza LUXE_BAJA_SECRETO (lib/campanas/baja.ts) en vez de exigir una
  // variable de entorno nueva: la bandeja de campañas ya no funciona sin
  // ella (todo envío arma un enlace de baja), así que no suma un requisito
  // de despliegue nuevo, y separar el dominio de la firma (ver `firmar`
  // abajo, el prefijo fijo antes del contenido) alcanza para que un token
  // de baja nunca pueda pasar como firma de previsualización ni al revés,
  // sin necesitar un secreto propio.
  return process.env.LUXE_BAJA_SECRETO ?? '';
}

// Dominio de la firma: sin este prefijo fijo, alguien con un enlace de baja
// real (`correo.firma`, lib/campanas/baja.ts) podría, en teoría, reusar esa
// misma firma HMAC como si fuera una firma de previsualización si el
// contenido firmado coincidiera por casualidad -- con el prefijo, las dos
// firman TEXTOS DISTINTOS aunque compartan secreto, así que una nunca sirve
// como la otra.
const DOMINIO_FIRMA = 'campana-personalizada-previsualizada';

function firmar(asunto: string, html: string): string {
  return createHmac('sha256', secreto()).update(`${DOMINIO_FIRMA} ${asunto} ${html}`).digest('hex');
}

function igualesEnTiempoConstante(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// La previsualización pesa más que nunca con una plantilla propia -- "que
// sea imposible mandar una campaña con HTML pegado sin haberla visto"
// (pedido explícito). Un botón deshabilitado del lado del cliente es fácil
// de saltarse (herramientas de desarrollador, o simplemente un bug futuro
// en VistaCampanas.tsx) -- esta firma es lo que lo vuelve una garantía real:
// POST /api/campanas/previsualizar la calcula sobre el asunto y el html YA
// SANEADOS que de verdad se van a mandar, y POST /api/campanas/crear
// vuelve a sanear el html crudo que le llega (nunca confía en un html "ya
// saneado" que mande el cliente) y exige que la firma que le llegue
// coincida con la que ÉL MISMO recalcula sobre ese resultado. Como
// `sanitizarHtmlPersonalizado` es una función pura, el mismo html crudo
// produce siempre el mismo saneado -- así que la única forma de tener una
// firma válida para un asunto+html dado es haber pasado ese asunto+html,
// tal cual, por POST /api/campanas/previsualizar. Cualquier edición
// después -- un carácter que cambie en el asunto o en el html pegado -- deja
// de coincidir, y hay que previsualizar de nuevo.
export function firmarPrevisualizacion(asunto: string, html: string): string {
  return firmar(asunto, html);
}

export function previsualizacionValida(asunto: string, html: string, firma: string): boolean {
  if (!secreto() || !firma) return false;
  return igualesEnTiempoConstante(firma, firmar(asunto, html));
}
