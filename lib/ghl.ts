import type { LeadInput } from '@/lib/validation';

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

export type GhlResult = { ok: true; contactId: string } | { ok: false; error: string };

type Deps = {
  apiKey: string;
  locationId: string;
  fetchImpl?: typeof fetch;
};

function partirNombre(completo: string) {
  const partes = completo.trim().split(/\s+/);
  return { firstName: partes[0] ?? '', lastName: partes.slice(1).join(' ') || undefined };
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
    return { ok: true, contactId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
