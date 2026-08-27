import { config } from '@/lib/agente/config';

// Única lógica del proyecto para escribir en un contacto de GoHighLevel sin
// pisarlo. La usan tanto el agente conversacional (`lib/agente/acciones.ts`)
// como el cotizador (`lib/cotizador/ghl.ts`): antes de esto cada uno tenía su
// propia versión del upsert, y la del cotizador no tenía ninguna de estas
// reglas — la primera cotización real a un contacto de la base importada le
// borraba tags, nombre y origen (hallazgo C2 de la revisión final).
//
// Reglas, todas verificadas contra la API real (ver docs/ghl-estimate-payload.md,
// sección "Ronda de correcciones 2"):
// - LEE el contacto antes de escribir: el PUT sobrescribe, y un asesor pudo
//   haber corregido un dato a mano.
// - Sólo rellena campos vacíos (firstName, email, phone, companyName,
//   source): nunca pisa un valor que el contacto ya tenía.
// - Los tags del PUT reemplazan el array completo, así que siempre se
//   conservan los previos y se suman los nuevos.
// - `city` NUNCA se escribe: en la base importada ese campo lleva la ruta de
//   visita comercial, no la ciudad del cliente.
// - El nombre de la PERSONA (no el del negocio) va también a un campo
//   personalizado, porque en la base importada `firstName` lleva el nombre
//   comercial.
const BASE = 'https://services.leadconnectorhq.com';
const VERSION_CONTACTOS = '2021-07-28';

export type DepsContacto = { apiKey: string; fetchImpl?: typeof fetch };

export type CamposContacto = {
  // Nombre de la persona que pide la cotización o escribe por chat — no el
  // nombre comercial del negocio. Rellena `firstName` sólo si está vacío, y
  // siempre va también al campo personalizado `persona_contacto`.
  // `| null` porque `Datos` (lib/agente/estado.ts) representa "aún no sé
  // este dato" con `null`, no con `undefined`.
  nombre?: string | null;
  email?: string | null;
  telefono?: string | null;
  empresa?: string | null; // companyName, sólo si está vacío
  source?: string | null; // sólo si está vacío
};

function cabeceras(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: VERSION_CONTACTOS,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function partirNombre(completo: string) {
  const partes = completo.trim().split(/\s+/);
  return { firstName: partes[0] ?? '', lastName: partes.slice(1).join(' ') || undefined };
}

// Nunca lanza: quien llama decide si un fallo aquí debe bloquear el resto del
// flujo (el agente, que ya respondió) o no (el cotizador, que ya tiene un
// contactId utilizable). Devuelve el texto del error para el log.
export async function escribirContactoSinPisar(
  contactId: string,
  campos: CamposContacto,
  tagsNuevos: string[],
  deps: DepsContacto,
): Promise<string | undefined> {
  const { apiKey, fetchImpl = fetch } = deps;

  let actual: Record<string, unknown>;
  try {
    const res = await fetchImpl(`${BASE}/contacts/${contactId}`, { headers: cabeceras(apiKey) });
    if (!res.ok) {
      // Si no sabemos qué hay, no escribimos. No se arriesga pisar a ciegas.
      return `GHL lectura de contacto ${res.status}: no se escribieron los campos`;
    }
    actual = (JSON.parse(await res.text()) as { contact?: Record<string, unknown> }).contact ?? {};
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  const vacio = (campo: string) => {
    const v = actual[campo];
    return v === undefined || v === null || v === '';
  };

  const cuerpo: Record<string, unknown> = {};
  if (campos.nombre) {
    if (vacio('firstName')) Object.assign(cuerpo, partirNombre(campos.nombre));
    cuerpo.customFields = [{ key: config.CAMPO_PERSONA, field_value: campos.nombre }];
  }
  if (campos.email && vacio('email')) cuerpo.email = campos.email;
  if (campos.telefono && vacio('phone')) cuerpo.phone = campos.telefono;
  if (campos.empresa && vacio('companyName')) cuerpo.companyName = campos.empresa;
  if (campos.source && vacio('source')) cuerpo.source = campos.source;

  // `city` NUNCA se escribe: ver el comentario del encabezado. No hay rama
  // que la toque a propósito — así queda imposible de reintroducir sin
  // agregar una línea nueva y explícita.

  const previos = Array.isArray(actual.tags) ? (actual.tags as string[]) : [];
  const deseados = [...new Set([...previos, ...tagsNuevos])];
  const faltanTags = deseados.length > previos.length;

  // Se escribe si hay algún campo que rellenar O si faltan tags por poner. Un
  // contacto importado ya trae casi todo lleno del ERP, así que sin la
  // segunda condición nunca recibiría el tag nuevo.
  if (Object.keys(cuerpo).length === 0 && !faltanTags) return undefined;

  cuerpo.tags = deseados;

  try {
    const res = await fetchImpl(`${BASE}/contacts/${contactId}`, {
      method: 'PUT',
      headers: cabeceras(apiKey),
      body: JSON.stringify(cuerpo),
    });
    if (!res.ok) return `GHL contacto ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
