import 'server-only';

// Trae los contactos de una zona comercial desde GoHighLevel, paginado.
// Mismo patrón que lib/agente/acciones.ts: `fetchImpl` inyectable, nunca
// lanza, cabeceras con `Version`, se prueba sin red.

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

// Las trece zonas comerciales del campo personalizado `zona_comercial`
// (docs/ghl-prompt-campos-personalizados.md, campo #6). "Revisión manual"
// no es una zona geográfica -- son los 526 contactos que la importación no
// pudo ubicar (docs/ghl-smart-lists.md) -- pero vive en el mismo campo y
// desplegable, así que se puede pedir "los contactos de tal zona" para ella
// exactamente igual que para las otras doce.
export const ZONAS_COMERCIALES = [
  'GAM Oeste',
  'GAM Centro',
  'GAM Este / Cartago',
  'Heredia / Norte GAM',
  'Alajuela / Occidente',
  'Zona Norte',
  'Guanacaste Costa',
  'Guanacaste Interior',
  'Península Nicoya',
  'Pacífico Central',
  'Pacífico Sur',
  'Caribe',
  'Revisión manual',
] as const;
export type ZonaComercial = (typeof ZONAS_COMERCIALES)[number];

// Clave del campo personalizado (no su id): ver el aviso grande más abajo,
// junto a `contactosPorZona`, sobre por qué esto no está verificado contra
// la API real.
const CAMPO_ZONA = 'zona_comercial';

// Máximo que acepta `pageLimit` en `/contacts/search`.
const TAMANO_PAGINA = 100;

// El nombre tal cual viene del CRM (`firstName`). En esta base importada
// casi siempre es el nombre del negocio, no el de una persona
// (docs/ghl-base-comercial-2026.md) -- es la fuente tanto de `{{empresa}}`
// como de `{{nombre}}` (lib/campanas/marcadores.ts decide cuál de las dos
// formas corresponde para el saludo).
export type ContactoZona = {
  contactId: string;
  nombreCrm: string;
  // `null` cuando el contacto no tiene correo en GHL. A ese contacto no se
  // le puede escribir nada -- se devuelve explícito, en vez de omitirlo en
  // silencio, para que la pantalla (parte 2) lo muestre y no lo cuente
  // como destinatario. Ver `conCorreo` más abajo.
  correo: string | null;
};

// La forma que necesita el resto de la bandeja de campañas (Tarea 3 y 4)
// para un contacto al que SÍ se le puede escribir: `correo` ya no es
// nullable. `conCorreo` (abajo) es la única forma de obtener este tipo a
// partir de `ContactoZona[]`.
export type DestinatarioCampana = {
  contactId: string;
  correo: string;
  nombreCrm: string;
};

export type DepsGhlContactos = { apiKey: string; locationId: string; fetchImpl?: typeof fetch };

export type ResultadoContactosZona =
  | { ok: true; contactos: ContactoZona[] }
  | { ok: false; error: string };

function cabeceras(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

type ContactoCrudo = { id?: unknown; firstName?: unknown; email?: unknown };

function aContactoZona(c: ContactoCrudo): ContactoZona | null {
  if (typeof c.id !== 'string' || !c.id) return null;
  const nombreCrm = typeof c.firstName === 'string' ? c.firstName.trim() : '';
  const correo = typeof c.email === 'string' && c.email.trim() ? c.email.trim() : null;
  return { contactId: c.id, nombreCrm, correo };
}

// Trae TODOS los contactos de una zona comercial, paginando hasta que una
// página vuelva con menos de `TAMANO_PAGINA` filas.
//
// AVISO -- NO VERIFICADO CONTRA LA API REAL (mismo criterio de honestidad
// que `vacioPersonaContacto` en lib/ghl-contacto.ts para un caso parecido):
// `POST /contacts/search` (Version 2021-07-28) reemplaza al `GET /contacts/`
// ya deprecado, y su cabecera de versión y su forma general de paginado
// (`page`/`pageLimit`, hasta 100 por página) están confirmados contra el
// spec público de GoHighLevel (github.com/GoHighLevel/highlevel-api-docs,
// apps/contacts.json). Lo que NO está confirmado es el shape exacto de
// `filters` para un campo personalizado: se arma acá como
// `{ field: 'customFields.zona_comercial', operator: 'eq', value: zona }`,
// que es el formato que documentan tanto el marketplace de GoHighLevel como
// varias integraciones de terceros contra esta misma API -- pero el spec
// público que se pudo inspeccionar no publica el shape de esa parte del
// cuerpo, y nadie probó esto contra la location real de Luxe. Si el filtro
// de un campo personalizado en realidad se identifica por ID en vez de por
// `key` (como sí pasa al LEER `customFields` de un contacto ya traído --
// ver el comentario de `vacioPersonaContacto` en lib/ghl-contacto.ts, que
// documenta la misma ambigüedad id/key del lado de lectura), esta llamada
// devolvería CERO contactos para cada zona sin ningún error que lo delate
// -- un fallo silencioso, no un 4xx.
//
// Antes de usar esto en producción: probarlo contra la location real con
// una zona chica ("Guanacaste Interior", 27 contactos según
// docs/ghl-smart-lists.md) y confirmar que el conteo coincide.
export async function contactosPorZona(
  zona: ZonaComercial,
  deps: DepsGhlContactos,
): Promise<ResultadoContactosZona> {
  const { apiKey, locationId, fetchImpl = fetch } = deps;
  const contactos: ContactoZona[] = [];
  let page = 1;

  for (;;) {
    let res: Response;
    try {
      res = await fetchImpl(`${BASE}/contacts/search`, {
        method: 'POST',
        headers: cabeceras(apiKey),
        body: JSON.stringify({
          locationId,
          page,
          pageLimit: TAMANO_PAGINA,
          filters: [{ field: `customFields.${CAMPO_ZONA}`, operator: 'eq', value: zona }],
        }),
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const texto = await res.text();
    if (!res.ok) {
      return { ok: false, error: `GHL búsqueda de contactos ${res.status}: ${texto.slice(0, 300)}` };
    }

    let datos: { contacts?: ContactoCrudo[] };
    try {
      datos = JSON.parse(texto);
    } catch {
      return { ok: false, error: `GHL respondió con JSON ilegible: ${texto.slice(0, 200)}` };
    }

    const lote = datos.contacts ?? [];
    for (const crudo of lote) {
      const contacto = aContactoZona(crudo);
      if (contacto) contactos.push(contacto);
    }

    if (lote.length < TAMANO_PAGINA) break;
    page++;
  }

  return { ok: true, contactos };
}

// Separa quién tiene correo (a quien SÍ se le puede escribir) de quien no.
// Función pura, para que la pantalla (parte 2) pueda mostrar algo como
// "3.340 contactos, 214 sin correo" sin repetir este filtro cada vez que lo
// necesite, y para que la lista que de verdad alimenta un envío nunca
// incluya un `correo: null` por descuido -- acá el tipo ya lo prohíbe.
export function conCorreo(contactos: readonly ContactoZona[]): DestinatarioCampana[] {
  return contactos
    .filter((c): c is ContactoZona & { correo: string } => c.correo !== null)
    .map((c) => ({ contactId: c.contactId, correo: c.correo, nombreCrm: c.nombreCrm }));
}

// Las trece zonas de una sola vez, en paralelo -- el camino de ~47
// peticiones HTTP contra GHL que ya usaba `app/api/campanas/zonas/route.ts`
// en solitario, sacado a este módulo para que cualquier otro lugar que
// necesite "las trece zonas completas" (la cola del envío programado,
// lib/campanas/cola.ts) lo comparta en vez de volver a lanzar sus propias
// trece consultas. Cada zona resuelve independiente -- el fallo de UNA no
// tumba a las demás, mismo criterio que ya tenía la ruta.
export async function contactosDeTodasLasZonas(
  deps: DepsGhlContactos,
): Promise<Record<ZonaComercial, ResultadoContactosZona>> {
  const entradas = await Promise.all(
    ZONAS_COMERCIALES.map(async (zona) => [zona, await contactosPorZona(zona, deps)] as const),
  );
  return Object.fromEntries(entradas) as Record<ZonaComercial, ResultadoContactosZona>;
}
