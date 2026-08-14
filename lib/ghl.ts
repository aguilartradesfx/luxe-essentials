import type { LeadInput } from '@/lib/validation';

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

export type GhlResult =
  | { ok: true; contactId: string; notaError?: string }
  | { ok: false; error: string };

type Deps = {
  apiKey: string;
  locationId: string;
  fetchImpl?: typeof fetch;
};

function partirNombre(completo: string) {
  const partes = completo.trim().split(/\s+/);
  return { firstName: partes[0] ?? '', lastName: partes.slice(1).join(' ') || undefined };
}

// Construye el cuerpo de la nota que verá el equipo de ventas en GHL.
// Se omite por completo si no hay cantidad ni mensaje: una nota vacía es
// ruido en la línea de tiempo del contacto.
function construirNota(lead: LeadInput): string | undefined {
  const cantidad = lead.cantidad?.trim();
  const mensaje = lead.mensaje?.trim();
  if (!cantidad && !mensaje) return undefined;

  const lineas = ['Solicitud de cotización desde la landing de Luxe Essentials.'];
  if (cantidad) lineas.push(`Cantidad estimada: ${cantidad}`);
  if (mensaje) lineas.push(`Mensaje: ${mensaje}`);
  return lineas.join('\n');
}

// Nunca lanza: un fallo al crear la nota no debe hacer fallar el upsert del
// contacto, que ya se guardó correctamente en GHL.
async function crearNota(
  contactId: string,
  texto: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${BASE}/contacts/${contactId}/notes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ body: texto }),
    });

    const respuesta = await res.text();
    if (!res.ok) {
      return `GHL nota ${res.status}: ${respuesta.slice(0, 300)}`;
    }
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function upsertContact(lead: LeadInput, deps: Deps): Promise<GhlResult> {
  const { apiKey, locationId, fetchImpl = fetch } = deps;
  const { firstName, lastName } = partirNombre(lead.nombre);

  const body = {
    locationId,
    firstName,
    lastName,
    email: lead.email,
    phone: lead.telefono || undefined,
    companyName: lead.empresa || undefined,
    source: 'Landing Luxe Essentials',
    tags: ['landing', 'luxe-web', `linea-${lead.linea}`],
  };

  try {
    const res = await fetchImpl(`${BASE}/contacts/upsert`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    const texto = await res.text();
    if (!res.ok) {
      return { ok: false, error: `GHL ${res.status}: ${texto.slice(0, 300)}` };
    }

    const datos = JSON.parse(texto) as { contact?: { id?: string }; id?: string };
    const contactId = datos.contact?.id ?? datos.id;
    if (!contactId) {
      return { ok: false, error: `GHL respondió sin id de contacto: ${texto.slice(0, 300)}` };
    }

    const nota = construirNota(lead);
    if (!nota) {
      return { ok: true, contactId };
    }

    const notaError = await crearNota(contactId, nota, apiKey, fetchImpl);
    return notaError ? { ok: true, contactId, notaError } : { ok: true, contactId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
