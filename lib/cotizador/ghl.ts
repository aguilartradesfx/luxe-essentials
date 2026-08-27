import type { Cotizacion } from '@/lib/cotizador/tipos';
import { escribirContactoSinPisar } from '@/lib/ghl-contacto';

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

// Pipeline y etapas verificados contra la location el 2026-08-26 y
// re-sondeados en la ronda de correcciones 1 (2026-08-27, ver
// docs/ghl-estimate-payload.md). El sondeo de la ronda 1 encontró que el DTO
// de `/opportunities/` usa whitelist estricta: `pipelineStageName` no existe
// como propiedad válida y la API responde 422 ("property pipelineStageName
// should not exist") — la etapa se identifica SOLO por `pipelineStageId`.
// Ambos ids de acá abajo salieron de `GET /opportunities/pipelines`.
//
// Exportados para que la prueba que detecta un id obsoleto (ronda de
// correcciones 2, hallazgo C3) compare contra la misma fuente de verdad en
// vez de tener el UUID copiado a mano y arriesgarse a que ambos diverjan.
export const PIPELINE = 'vr8WB783pg2FsTQj6LiG';

// A dónde se mueve la oportunidad HOY. "Qualified", no "Proposal Sent":
// crearEstimate deja el Estimate en borrador dentro de GoHighLevel (ver el
// comentario grande más abajo, sobre el envío pendiente) y decir "Proposal
// Sent" sería anunciar un envío que nunca pasó. Confirmado contra
// `GET /opportunities/pipelines` el 2026-08-27 (ronda de correcciones 2,
// hallazgo C1).
export const ETAPA_CALIFICADA_ID = '95ab829f-202b-47db-a245-20be6aa8eba1'; // "Qualified"

// A dónde debe volver a moverse la oportunidad el día que exista la llamada
// que de verdad envía el Estimate al cliente (mismo comentario de más abajo).
// Se deja el id documentado acá, ya sondeado, para no tener que volver a
// consultar `GET /opportunities/pipelines` cuando llegue ese momento.
export const ETAPA_PROPUESTA_ID = '26ef30a9-dcc9-4bca-8197-da21ed9135fb'; // "Proposal Sent"

// Nota fija en toda cotización. Luxe: "se incluye un bordado de máximo 10x10 cm
// a un color. más grande o con colores los precios varían según muestra."
const NOTA_BORDADO =
  'Incluye bordado de hasta 10x10 cm a un color. Bordados de mayor tamaño o a varios colores se cotizan por separado según muestra.';
const NOTA_PRECIOS = 'Precios en colones. El IVA se detalla por separado.';

// Cuántos días queda vigente el precio cotizado. Sin esto, la cotización no
// dice hasta cuándo corre el precio, y un cliente podría reclamar un precio
// de hace un año como si siguiera en pie.
const DIAS_VIGENCIA = 30;

export type ParamsEstimate = {
  cotizacion: Cotizacion;
  cliente: { nombre: string; empresa?: string; email: string };
  contactId?: string;
};

export type DepsGhl = { apiKey: string; locationId: string; fetchImpl?: typeof fetch };

export type ResultadoEstimate =
  | { ok: true; estimateId: string; contactId: string; opportunityError?: string }
  // `contactId` va también en el camino de fallo, cuando se llegó a resolver
  // (recibido o recién creado) antes de que algo posterior fallara. Sin esto,
  // un Estimate que falla después de dar de alta un contacto nuevo pierde ese
  // id sin dejar rastro: el contacto queda huérfano en GHL y nadie en Luxe
  // sabe que existe.
  | { ok: false; error: string; contactId?: string };

function cabeceras(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// Sondeado en la ronda 1: `issueDate`/`expiryDate` son obligatorios (422 si
// se omiten) y la API los interpreta como fecha local, no UTC. Formato
// exigido: YYYY-MM-DD.
//
// Ronda de correcciones 2 (menor, de paso): el servidor corre en UTC (es lo
// normal en Vercel), así que `fecha.toISOString().slice(0, 10)` da el día
// calendario en UTC, no en Costa Rica. Una cotización armada a las 7pm hora
// tica (01:00 UTC del día siguiente) imprimía la fecha de mañana en
// `issueDate`. Se formatea explícitamente con el huso de Costa Rica; 'en-CA'
// es un atajo — es el locale cuyo formato corto ya es YYYY-MM-DD.
const FORMATEADOR_FECHA_CR = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Costa_Rica',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function formatearFecha(fecha: Date): string {
  return FORMATEADOR_FECHA_CR.format(fecha);
}

// Sondeado en la ronda 1: `(0.13*100).toFixed(0)` está bien para 13%, pero
// una tasa reducida como 2.5% da "IVA 3%" — el rótulo miente sobre un monto
// que en realidad es el 2.5%. Se muestran hasta dos decimales, sin ceros de
// más: 13 -> "13", 2.5 -> "2.5".
function formatearTasa(tasa: number): string {
  return (tasa * 100).toFixed(2).replace(/\.?0+$/, '');
}

// La API exige `contactDetails.id` no vacío pero NO valida que exista. Un id
// inventado produciría cotizaciones huérfanas, sin contacto al que hacerle
// seguimiento — justo lo contrario de lo que buscamos. Así que si no llega un
// contacto, se da de alta (o se reutiliza) antes de cotizar.
//
// El 100% de las cotizaciones de la pantalla pasan por acá, porque la
// pantalla nunca manda un `contactId`. Y un porcentaje real de esos correos
// pertenece a alguno de los 526 hoteles de la base comercial importada — un
// contacto que YA tiene tags de zona, nombre comercial y origen del ERP.
//
// Por eso el `POST /contacts/upsert` de acá abajo manda el mínimo posible
// (sólo `locationId` + `email`, la clave con la que GHL empareja contactos
// existentes): nunca firstName, nunca tags, nunca source en esta llamada.
// Verificado contra la API real (ver docs/ghl-estimate-payload.md, "Ronda de
// correcciones 2"): un segundo `POST /contacts/upsert` sobre el mismo email
// que omite un campo deja ese campo tal como estaba — no lo vacía. Antes de
// esta corrección (hallazgo C2) esa llamada SÍ mandaba firstName/source/tags
// y los reemplazaba a ciegas, borrando la segmentación comercial del contacto
// en la primera cotización real que se le hiciera.
//
// Con el contacto ya identificado, `escribirContactoSinPisar` (compartida con
// el agente conversacional, ver `lib/ghl-contacto.ts`) aplica las mismas
// reglas de no-pisar: sólo rellena firstName/companyName/source si estaban
// vacíos, nunca escribe `city`, y suma el tag `cotizacion` a los que ya
// tuviera en vez de reemplazarlos.
async function resolverContacto(
  p: ParamsEstimate, deps: Required<DepsGhl>,
): Promise<{ ok: true; contactId: string } | { ok: false; error: string }> {
  if (p.contactId) return { ok: true, contactId: p.contactId };

  let contactId: string;
  try {
    const res = await deps.fetchImpl(`${BASE}/contacts/upsert`, {
      method: 'POST',
      headers: cabeceras(deps.apiKey),
      body: JSON.stringify({ locationId: deps.locationId, email: p.cliente.email }),
    });
    const texto = await res.text();
    if (!res.ok) return { ok: false, error: `GHL contacto ${res.status}: ${texto.slice(0, 200)}` };
    const datos = JSON.parse(texto) as { contact?: { id?: string }; id?: string };
    const id = datos.contact?.id ?? datos.id;
    if (!id) return { ok: false, error: `GHL creó el contacto sin devolver id: ${texto.slice(0, 200)}` };
    contactId = id;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Best-effort: el contacto ya quedó resuelto (nuevo o existente) y la
  // cotización puede seguir aunque esto falle. Un fallo acá se registra pero
  // no debe convertir una cotización que sí se puede emitir en un error para
  // el vendedor.
  const errorEscritura = await escribirContactoSinPisar(
    contactId,
    {
      nombre: p.cliente.nombre,
      email: p.cliente.email,
      empresa: p.cliente.empresa,
      source: 'Cotizador Luxe Essentials',
    },
    ['cotizacion'],
    { apiKey: deps.apiKey, fetchImpl: deps.fetchImpl },
  );
  if (errorEscritura) {
    console.error('[cotizador] No se pudieron actualizar los datos del contacto en GHL.', errorEscritura);
  }

  return { ok: true, contactId };
}

// Nunca lanza: un fallo moviendo la Opportunity no debe invalidar un Estimate
// que ya se creó bien. Devuelve el texto del error para registrarlo.
//
// Sondeado contra la API real (docs/ghl-estimate-payload.md, "Ronda de
// correcciones 2", hallazgo C3): `POST /opportunities/` acepta un
// `pipelineStageId` inventado — un UUID que no existe, o texto que ni
// siquiera tiene forma de UUID — con 201, y en silencio deja la oportunidad
// en la primera etapa del pipeline ("New Lead"). Sin `opportunityError`, sin
// `ghl_error`, nada que avise que el seguimiento comercial se apagó. Si
// alguien en Luxe reordena o recrea la etapa objetivo desde la interfaz de
// GHL, este id hardcodeado queda obsoleto sin que nada lo grite.
//
// La defensa: la propia respuesta del POST devuelve el `pipelineStageId` que
// quedó guardado de verdad. Comparar contra el que se mandó detecta el
// desajuste sin ninguna petición adicional — la información ya está en la
// respuesta que de todos modos hay que leer.
//
// Se decidió NO resolver el id por nombre contra `GET /opportunities/pipelines`
// en cada cotización. Esa alternativa sí sería inmune a que alguien
// renombre o reordene la etapa (identificaría la etapa por nombre en vez de
// por id fijo), pero cuesta una petición HTTP extra en el camino caliente de
// cada cotización, y una etapa de pipeline es algo que casi nunca cambia —
// el costo recurrente no se justifica para un evento raro. Comparar la
// respuesta del propio POST logra el objetivo real (que un desajuste no pase
// en silencio) con petición cero de más: si el id quedó obsoleto, esta
// cotización concreta lo reporta con `opportunityError`, y alguien lo
// corrige a mano (o se decide entonces migrar a resolución por nombre) — no
// hace falta pagar el costo en cada cotización para lograrlo.
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
        // Por id, no por nombre: la API rechaza `pipelineStageName` con 422
        // ("property pipelineStageName should not exist"). "Qualified", no
        // "Proposal Sent": ver el comentario de `ETAPA_CALIFICADA_ID` arriba
        // y el de `crearEstimate` más abajo sobre el envío pendiente.
        pipelineStageId: ETAPA_CALIFICADA_ID,
        status: 'open',
        contactId,
        monetaryValue: p.cotizacion.total,
      }),
    });
    const texto = await res.text();
    if (!res.ok) return `GHL oportunidad ${res.status}: ${texto.slice(0, 200)}`;

    let datos: { opportunity?: { pipelineStageId?: string }; pipelineStageId?: string };
    try {
      datos = JSON.parse(texto);
    } catch {
      // 2xx con JSON inválido: no se puede confirmar la etapa. Se reporta en
      // vez de asumir que salió bien.
      return `GHL oportunidad creada pero con respuesta ilegible, no se pudo confirmar la etapa: ${texto.slice(0, 200)}`;
    }
    const etapaGuardada = datos.opportunity?.pipelineStageId ?? datos.pipelineStageId;
    if (etapaGuardada !== ETAPA_CALIFICADA_ID) {
      return (
        `GHL aceptó la oportunidad con 201 pero quedó en la etapa equivocada: ` +
        `se pidió "${ETAPA_CALIFICADA_ID}" y GHL guardó "${etapaGuardada ?? '(sin dato)'}". ` +
        `El id de la etapa "Qualified" puede haber cambiado en GHL.`
      );
    }
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// IMPORTANTE — esta función NUNCA envía la cotización al cliente (hallazgo
// C1 de la ronda de correcciones 2). Lo que hace es: resolver el contacto,
// crear el Estimate vía `POST /invoices/estimate` y mover la Opportunity a
// "Qualified" (ver `ETAPA_CALIFICADA_ID` arriba). Ninguna de esas tres
// llamadas envía nada — el Estimate queda en estado `draft` dentro de
// GoHighLevel hasta que alguien lo abra ahí y lo mande a mano. Por eso la
// fila en Supabase se marca `estado: 'creada'`, no `'enviada'`
// (app/api/cotizacion/route.ts), y la Opportunity va a "Qualified", no a
// "Proposal Sent" — sería mentir sobre un envío que no ocurrió.
//
// Falta la llamada de envío (algo como `POST /invoices/estimate/:id/send`,
// sin confirmar todavía contra la API real). No se implementó en esta ronda
// a propósito: mandarle un documento a un hotel real es una acción hacia
// afuera e irreversible, y antes de dispararla en automático hay que
// verificar a mano, en la interfaz de GoHighLevel, que el Estimate no
// muestra un botón de pago — el cliente pidió explícitamente que sus
// clientes no vean esa opción, y eso no se puede comprobar por API, solo
// mirando la plantilla en la pantalla de GHL. Esa verificación (y la
// decisión de activar el envío automático) le toca al dueño del proyecto.
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

  const hoy = new Date();
  const vencimiento = new Date(hoy);
  vencimiento.setDate(vencimiento.getDate() + DIAS_VIGENCIA);

  const cuerpo = {
    altId: locationId,
    altType: 'location',
    // Obligatorio a nivel de esquema: sin `title` la API responde 500.
    title: `Cotización — ${p.cliente.empresa ?? p.cliente.nombre}`,
    name: `Cotización — ${p.cliente.empresa ?? p.cliente.nombre}`,
    currency: 'CRC',
    // Sondeado en la ronda 1: si se omite, la API lo pone en `true` por su
    // cuenta. Se manda explícito para que quede documentado a propósito, no
    // como un default implícito que podría cambiar sin avisar. `true` es lo
    // correcto acá: son cotizaciones reales para clientes reales, no de
    // prueba.
    liveMode: true,
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
              name: `IVA ${formatearTasa(p.cotizacion.tasaIva)}%`,
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
    // Obligatorios (422 si faltan). Emisión hoy, vencimiento a
    // `DIAS_VIGENCIA` días: sin esto, la cotización no dice hasta cuándo
    // corre el precio.
    issueDate: formatearFecha(hoy),
    expiryDate: formatearFecha(vencimiento),
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
    if (!res.ok) return { ok: false, error: `GHL estimate ${res.status}: ${texto.slice(0, 300)}`, contactId };

    const datos = JSON.parse(texto) as { _id?: string; id?: string };
    const id = datos._id ?? datos.id;
    if (!id) return { ok: false, error: `GHL respondió sin id: ${texto.slice(0, 300)}`, contactId };
    estimateId = id;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), contactId };
  }

  const opportunityError = await moverOportunidad(p, contactId, completas);
  return opportunityError
    ? { ok: true, estimateId, contactId, opportunityError }
    : { ok: true, estimateId, contactId };
}
