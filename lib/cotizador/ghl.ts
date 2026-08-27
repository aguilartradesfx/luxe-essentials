import type { Cotizacion } from '@/lib/cotizador/tipos';

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

// Pipeline y etapa verificados contra la location el 2026-08-26.
const PIPELINE = 'vr8WB783pg2FsTQj6LiG';
const ETAPA_PROPUESTA = 'Proposal Sent';

// Nota fija en toda cotización. Luxe: "se incluye un bordado de máximo 10x10 cm
// a un color. más grande o con colores los precios varían según muestra."
const NOTA_BORDADO =
  'Incluye bordado de hasta 10x10 cm a un color. Bordados de mayor tamaño o a varios colores se cotizan por separado según muestra.';
const NOTA_PRECIOS = 'Precios en colones. El IVA se detalla por separado.';

export type ParamsEstimate = {
  cotizacion: Cotizacion;
  cliente: { nombre: string; empresa?: string; email: string };
  contactId?: string;
};

export type DepsGhl = { apiKey: string; locationId: string; fetchImpl?: typeof fetch };

export type ResultadoEstimate =
  | { ok: true; estimateId: string; contactId: string; opportunityError?: string }
  | { ok: false; error: string };

function cabeceras(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// La API exige `contactDetails.id` no vacío pero NO valida que exista. Un id
// inventado produciría cotizaciones huérfanas, sin contacto al que hacerle
// seguimiento — justo lo contrario de lo que buscamos. Así que si no llega un
// contacto, se da de alta antes de cotizar.
async function resolverContacto(
  p: ParamsEstimate, deps: Required<DepsGhl>,
): Promise<{ ok: true; contactId: string } | { ok: false; error: string }> {
  if (p.contactId) return { ok: true, contactId: p.contactId };

  const partes = p.cliente.nombre.trim().split(/\s+/);
  try {
    const res = await deps.fetchImpl(`${BASE}/contacts/upsert`, {
      method: 'POST',
      headers: cabeceras(deps.apiKey),
      body: JSON.stringify({
        locationId: deps.locationId,
        firstName: partes[0] ?? '',
        lastName: partes.slice(1).join(' ') || undefined,
        email: p.cliente.email,
        companyName: p.cliente.empresa,
        source: 'Cotizador Luxe Essentials',
        tags: ['cotizacion'],
      }),
    });
    const texto = await res.text();
    if (!res.ok) return { ok: false, error: `GHL contacto ${res.status}: ${texto.slice(0, 200)}` };
    const datos = JSON.parse(texto) as { contact?: { id?: string }; id?: string };
    const id = datos.contact?.id ?? datos.id;
    if (!id) return { ok: false, error: `GHL creó el contacto sin devolver id: ${texto.slice(0, 200)}` };
    return { ok: true, contactId: id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Nunca lanza: un fallo moviendo la Opportunity no debe invalidar un Estimate
// que ya se creó bien. Devuelve el texto del error para registrarlo.
async function moverOportunidad(
  p: ParamsEstimate, contactId: string, deps: Required<DepsGhl>,
): Promise<string | undefined> {
  try {
    const res = await deps.fetchImpl(`${BASE}/opportunities/`, {
      method: 'POST',
      headers: cabeceras(deps.apiKey),
      body: JSON.stringify({
        pipelineId: PIPELINE,
        locationId: deps.locationId,
        name: `Cotización — ${p.cliente.empresa ?? p.cliente.nombre}`,
        pipelineStageName: ETAPA_PROPUESTA,
        status: 'open',
        contactId,
        monetaryValue: p.cotizacion.total,
      }),
    });
    if (!res.ok) return `GHL oportunidad ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function crearEstimate(
  p: ParamsEstimate, deps: DepsGhl,
): Promise<ResultadoEstimate> {
  const { apiKey, locationId, fetchImpl = fetch } = deps;
  const completas = { apiKey, locationId, fetchImpl };

  const contacto = await resolverContacto(p, completas);
  if (!contacto.ok) return { ok: false, error: contacto.error };
  const contactId = contacto.contactId;

  const notas = [NOTA_PRECIOS, NOTA_BORDADO];
  if (p.cotizacion.bordadoEspecial) {
    notas.push('El bordado solicitado excede el estándar: el precio final se confirma contra muestra.');
  }

  const cuerpo = {
    altId: locationId,
    altType: 'location',
    // Obligatorio a nivel de esquema: sin `title` la API responde 500.
    title: `Cotización — ${p.cliente.empresa ?? p.cliente.nombre}`,
    name: `Cotización — ${p.cliente.empresa ?? p.cliente.nombre}`,
    currency: 'CRC',
    businessDetails: { name: 'Luxe Essentials' },
    contactDetails: {
      id: contactId,
      name: p.cliente.nombre,
      email: p.cliente.email,
      companyName: p.cliente.empresa,
    },
    items: [
      ...p.cotizacion.lineas.map((l) => ({
        name: l.nombre,
        // El desglose del set va aquí: sin él, un hotel lee "set de 600 hilos
        // king ₡90.000" y no sabe qué recibe por ese dinero.
        description: [
          l.contenido?.length ? `Incluye: ${l.contenido.join(', ')}.` : null,
          l.descuentoPct > 0 ? `Descuento aplicado: ${l.descuentoPct}%.` : null,
        ]
          .filter(Boolean)
          .join(' '),
        currency: 'CRC',
        // Ya descontado y redondeado por `calcular`. GoHighLevel no descuenta.
        amount: l.precioUnitario,
        qty: l.cantidad,
        type: 'one_time' as const,
      })),
      // El IVA viaja como una línea más, con el entero que calculó nuestro
      // motor. Si se declarara con `taxes`, GoHighLevel lo recalcularía y
      // produciría decimales: 333 x 1,13 da 376,29, y entonces el total que ve
      // el cliente deja de coincidir con el que Luxe cotizó.
      ...(p.cotizacion.iva > 0
        ? [
            {
              name: `IVA ${(p.cotizacion.tasaIva * 100).toFixed(0)}%`,
              description: 'Impuesto al valor agregado sobre el subtotal ya descontado.',
              currency: 'CRC',
              amount: p.cotizacion.iva,
              qty: 1,
              type: 'one_time' as const,
            },
          ]
        : []),
    ],
    // Fijo en cero a propósito. El descuento global de GoHighLevel se aplica a
    // TODAS las líneas, incluida la del IVA, así que usarlo descuadraría el
    // total. Los descuentos ya están dentro de cada `amount`.
    discount: { type: 'percentage' as const, value: 0 },
    // Obligatorio. Esta cotización no se repite.
    frequencySettings: { enabled: false },
    termsNotes: notas.join(' '),
  };

  let estimateId: string;
  try {
    const res = await fetchImpl(`${BASE}/invoices/estimate`, {
      method: 'POST',
      headers: cabeceras(apiKey),
      body: JSON.stringify(cuerpo),
    });
    const texto = await res.text();
    if (!res.ok) return { ok: false, error: `GHL estimate ${res.status}: ${texto.slice(0, 300)}` };

    const datos = JSON.parse(texto) as { _id?: string; id?: string };
    const id = datos._id ?? datos.id;
    if (!id) return { ok: false, error: `GHL respondió sin id: ${texto.slice(0, 300)}` };
    estimateId = id;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const opportunityError = await moverOportunidad(p, contactId, completas);
  return opportunityError
    ? { ok: true, estimateId, contactId, opportunityError }
    : { ok: true, estimateId, contactId };
}
