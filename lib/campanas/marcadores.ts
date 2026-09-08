import 'server-only';

// Resuelve los tres marcadores que usan las cuatro plantillas de campaña
// (Tarea 2 -- todavía sin el texto real, ver el reporte de esta tarea):
// `{{nombre}}`, `{{empresa}}` y `{{unsubscribe_url}}`. Sin depender de qué
// dice cada plantilla, así que este módulo queda listo desde ya y no hay
// que tocarlo cuando llegue el texto real de las cuatro.

// Escapa cualquier valor que venga del CRM antes de interpolarlo en HTML.
// MISMA implementación que `escaparHtml` en
// lib/cotizador/correo-invitacion.ts (no exportada desde ahí, se duplica a
// propósito -- mismo criterio que `colones()` en ese mismo archivo: no vale
// la pena cruzar el módulo por una función de cuatro líneas). Hay precedente
// real de por qué esto no es opcional: un nombre sin escapar coló una
// etiqueta `<a href>` de phishing en el correo de invitación, con una
// prueba que lo ancla (tests/correo-invitacion.test.ts). Acá el riesgo es
// mayor, no menor: el nombre lo escribe quien sea que cargó el ERP, para
// 3.340 contactos que nadie en Luxe revisó uno por uno.
export function escaparHtml(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Palabras que delatan un nombre de NEGOCIO, no de persona. Comparadas
// contra cada palabra del nombre ya normalizada (sin tildes, en minúsculas,
// sin signos) -- nunca como substring del nombre completo: "Barrantes"
// contiene "bar" como substring pero es un apellido real, y compararlo así
// lo marcaría "negocio" por error. Ver `normalizarToken` más abajo.
//
// La lista no pretende ser exhaustiva -- es una heurística barata, no un
// modelo (ver el comentario grande de `pareceNombrePersona`) -- así que se
// arma con el vocabulario real de esta base: los segmentos de negocio de
// docs/ghl-base-comercial-2026.md (hotel, restaurante, cafetería, bar,
// panadería, supermercado, abastecedor, tienda...), los sufijos legales
// ticos más comunes (S.A., S.R.L., Ltda.), y el resto del vocabulario
// comercial genérico que aparece en una base de hoteles y comercios de
// Costa Rica.
const INDICADORES_NEGOCIO = new Set([
  // Sufijos legales / societarios
  'sa', 'srl', 'ltda', 'cia', 'ltd', 'inc', 'corp',
  // Hospedaje
  'hotel', 'hoteles', 'resort', 'hostal', 'hospedaje', 'apartotel',
  'cabinas', 'cabina', 'villas', 'motel', 'posada',
  // Comida y bebida
  'restaurante', 'restaurant', 'soda', 'cafe', 'cafeteria', 'bar',
  'cantina', 'pizzeria', 'marisqueria', 'panaderia', 'panificadora',
  'reposteria', 'heladeria', 'catering', 'asadero', 'rosticeria',
  // Retail / comercio
  'supermercado', 'super', 'minisuper', 'mini', 'market', 'abarrotes',
  'pulperia', 'tienda', 'bazar', 'boutique', 'abastecedor', 'abastecedora',
  'distribuidor', 'distribuidora', 'importadora', 'exportadora',
  'mayorista', 'ferreteria', 'farmacia',
  // Servicios / salud / educación
  'clinica', 'laboratorio', 'spa', 'gimnasio', 'salon', 'academia',
  'instituto', 'colegio', 'escuela', 'universidad',
  // Corporativo / genérico
  'oficina', 'empresa', 'negocio', 'compania', 'corporacion', 'grupo',
  'inversiones', 'comercial', 'servicios', 'consultores', 'asociados',
  'constructora', 'inmobiliaria', 'financiera', 'seguros', 'banco',
  'agencia', 'transportes', 'transporte', 'logistica', 'asociacion',
  'cooperativa', 'fundacion', 'iglesia',
  // Lugares / infraestructura
  'bodega', 'almacen', 'deposito', 'plaza', 'centro', 'complejo',
  'condominio', 'edificio', 'torre', 'finca', 'hacienda', 'rancho',
  'club', 'taller', 'autolote',
  // Conector casi ausente de nombres de persona en 2-3 palabras, muy
  // presente en nombres de negocio ("Bar y Restaurante El Sol").
  'y',
]);

// Quita tildes, pasa a minúsculas y descarta todo lo que no sea una letra
// (puntos, guiones, dígitos) -- para que "S.A." y "SA" comparen igual contra
// `INDICADORES_NEGOCIO`, y para que un token con dígitos u otros símbolos
// quede vacío y lo rechace el chequeo de abajo.
function normalizarToken(token: string): string {
  return token
    .normalize('NFD')
    // Marcas diacríticas combinantes (tildes, diéresis) que `normalize('NFD')`
    // separa de su letra base -- por punto de código (U+0300-U+036F), no
    // como caracteres literales pegados en el código fuente: un combinante
    // suelto en el archivo es invisible y frágil de revisar.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

// La regla del diseño (docs/superpowers/specs/2026-09-08-campanas-design.md):
// se personaliza el saludo SÓLO cuando el nombre parece de una persona; ante
// la duda, genérico. En esta base el campo casi siempre trae el nombre del
// negocio ("supermercado poval", "restaurante ardere", "cafe rojo") -- así
// que el sesgo tiene que ser hacia "no, no parece persona", no al revés.
//
// Es una heurística a propósito, no un modelo de lenguaje: preguntarle a un
// modelo por cada uno de ~2.700 nombres con correo costaría más que la
// campaña entera, y el error que se tolera acá es mínimo -- equivocarse
// hacia lo genérico no cuesta nada; equivocarse hacia lo personal delata que
// el correo salió de una lista.
//
// Reglas, en orden, CUALQUIERA que falle devuelve `false` (genérico):
//   1. Ni un solo indicador de negocio (`INDICADORES_NEGOCIO`) entre las
//      palabras del nombre.
//   2. Dos o tres palabras -- ni una sola (ambigua: podría ser un apodo, un
//      alias corto, o sólo el nombre de pila sin apellido) ni cuatro o más
//      (los nombres de negocio largos, con "S.A." o varias palabras
//      descriptivas, caen casi siempre acá).
//   3. Cada palabra son sólo letras (con tildes y ñ) -- nada de dígitos, ni
//      abreviaturas con punto, ni siglas sueltas.
// Un nombre con guión o apóstrofe (apellidos compuestos como "Solís-Vindas"
// u "O'Brien") no pasa la regla 3 y queda genérico -- una persona real
// pierde el saludo personalizado, que es exactamente el error que este
// diseño prefiere sobre el otro.
export function pareceNombrePersona(nombreCrm: string): boolean {
  const tokens = nombreCrm.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 3) return false;

  const normalizados = tokens.map(normalizarToken);
  if (normalizados.some((t) => t.length === 0)) return false;
  if (normalizados.some((t) => INDICADORES_NEGOCIO.has(t))) return false;
  if (!tokens.every((t) => /^[a-zA-ZÀ-ÿ]+$/.test(t))) return false;

  return true;
}

function capitalizar(palabra: string): string {
  return palabra.length === 0 ? palabra : palabra.charAt(0).toUpperCase() + palabra.slice(1);
}

// El valor que sustituye a `{{nombre}}`. Devuelve el saludo YA ESCAPADO y
// con su propia puntuación adelante (", Ana") o la cadena vacía -- nunca el
// nombre a secas -- para que una plantilla escrita como
// "Buenos días{{nombre}}:" quede bien en los dos casos:
//   - "Buenos días, Ana:"  (parece persona)
//   - "Buenos días:"       (genérico -- sin la coma suelta que dejaría
//     "Buenos días :" si `{{nombre}}` sólo resolviera el nombre).
// Este es el contrato que las cuatro plantillas (Tarea 2) tienen que seguir
// al escribir el saludo: la coma y el espacio van DENTRO del marcador, no
// en el texto fijo de la plantilla.
export function marcadorNombre(nombreCrm: string): string {
  if (!pareceNombrePersona(nombreCrm)) return '';
  const primerNombre = nombreCrm.trim().split(/\s+/)[0] ?? '';
  return `, ${escaparHtml(capitalizar(primerNombre))}`;
}

export type DatosDestinatario = {
  // El nombre tal cual viene del CRM -- fuente de `{{empresa}}` (sin
  // heurística, tal cual) y de `{{nombre}}` (con la heurística de arriba).
  nombreCrm: string;
  unsubscribeUrl: string;
};

// Sustituye los tres marcadores en el HTML de una plantilla ya armada
// (`campanas.html`, migración 0019). `split(...).join(...)` en vez de una
// regex: reemplaza TODAS las apariciones (una plantilla puede repetir
// `{{empresa}}` más de una vez) sin pelear con caracteres especiales de
// regex en el marcador ni con el estado de `lastIndex` de un `replace`
// global reusado.
export function renderizarPlantilla(html: string, datos: DatosDestinatario): string {
  return html
    .split('{{empresa}}').join(escaparHtml(datos.nombreCrm))
    .split('{{nombre}}').join(marcadorNombre(datos.nombreCrm))
    .split('{{unsubscribe_url}}').join(escaparHtml(datos.unsubscribeUrl));
}
