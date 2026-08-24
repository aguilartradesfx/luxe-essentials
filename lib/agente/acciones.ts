import { config } from '@/lib/agente/config';
import type { CanalEnvio } from '@/lib/agente/canal';
import type { Datos } from '@/lib/agente/estado';

export type DepsEscritura = { apiKey: string; fetchImpl?: typeof fetch };

function cabeceras(apiKey: string, version: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: version,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

const ASUNTO_CORREO = 'Recibimos tu mensaje — Luxe Essentials';

export async function enviarMensaje(
  p: { contactId: string; canal: CanalEnvio; texto: string },
  deps: DepsEscritura,
): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string }> {
  const { apiKey, fetchImpl = fetch } = deps;

  const cuerpo: Record<string, unknown> = {
    type: p.canal,
    contactId: p.contactId,
    message: p.texto,
  };
  if (p.canal === 'Email') cuerpo.subject = ASUNTO_CORREO;

  try {
    const res = await fetchImpl(`${config.BASE_GHL}/conversations/messages`, {
      method: 'POST',
      headers: cabeceras(apiKey, config.VERSION_CONVERSACIONES),
      body: JSON.stringify(cuerpo),
    });
    const texto = await res.text();
    if (!res.ok) return { ok: false, error: `GHL envío ${res.status}: ${texto.slice(0, 200)}` };

    // Si GHL no devuelve id, el mensaje igual salió. Tratarlo como fallo haría
    // que se reenviara y el cliente lo recibiría dos veces. El precio de no
    // tener el id es que la guarda del humano lo verá como saliente ajeno y el
    // agente callará de más: el fallo seguro.
    const datos = JSON.parse(texto) as { messageId?: string; id?: string };
    return { ok: true, messageId: datos.messageId ?? datos.id ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function partirNombre(completo: string) {
  const partes = completo.trim().split(/\s+/);
  return { firstName: partes[0] ?? '', lastName: partes.slice(1).join(' ') || undefined };
}

// Nunca lanza: un fallo guardando los datos no debe borrar el hecho de que al
// cliente ya se le respondió. Devuelve el texto del error para el log.
//
// LEE el contacto antes de escribirlo. El PUT de GHL sobrescribe, y el asesor
// pudo haber corregido el correo o el teléfono a mano: el agente no tiene
// derecho a pisar eso con lo que dedujo de un chat.
export async function actualizarContacto(
  contactId: string, datos: Datos, deps: DepsEscritura,
): Promise<string | undefined> {
  const { apiKey, fetchImpl = fetch } = deps;

  // Sin ningún dato no hay nada que escribir, y ni siquiera vale la pena leer.
  const hayAlgo = Object.values(datos).some(Boolean);
  if (!hayAlgo) return undefined;

  let actual: Record<string, unknown>;
  try {
    const res = await fetchImpl(`${config.BASE_GHL}/contacts/${contactId}`, {
      headers: cabeceras(apiKey, config.VERSION_CONTACTOS),
    });
    if (!res.ok) {
      // Si no sabemos qué hay, no escribimos. Los datos igual quedan en la
      // nota, así que no se pierde nada y no se arriesga pisar a ciegas.
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
  if (datos.nombre && vacio('firstName')) Object.assign(cuerpo, partirNombre(datos.nombre));
  if (datos.email && vacio('email')) cuerpo.email = datos.email;
  if (datos.telefono && vacio('phone')) cuerpo.phone = datos.telefono;

  // `city` NO se escribe nunca. La importación de la base comercial 2026 mapea
  // "Subzona / ruta" a City, así que ese campo es la ruta de visita del cliente,
  // no su ciudad. Escribir ahí lo que alguien mencione por chat rompería la
  // segmentación comercial. La ubicación declarada vive sólo en la nota.

  // El nombre de la persona va a un campo propio: en la base importada
  // firstName lleva el nombre comercial del negocio, no el de nadie.
  if (datos.nombre) {
    cuerpo.customFields = [{ key: config.CAMPO_PERSONA, field_value: datos.nombre }];
  }

  const tagProducto = config.tagDeProducto(datos.producto);
  // Los tags del PUT reemplazan, así que se conservan los que ya tenía.
  const previos = Array.isArray(actual.tags) ? (actual.tags as string[]) : [];
  const deseados = [...new Set([...previos, ...config.TAGS_BASE, ...(tagProducto ? [tagProducto] : [])])];
  const faltanTags = deseados.length > previos.length;

  // Se escribe si hay algún campo que rellenar O si faltan tags por poner.
  // La segunda condición no es un detalle: un contacto que viene de la
  // importación ya trae correo y teléfono del ERP, así que no habrá ningún
  // campo vacío que justifique el PUT — y sin ella ese contacto nunca
  // recibiría el tag de interés, que es justo lo que el equipo usa para saber
  // con quién habló el agente y qué le interesaba.
  if (Object.keys(cuerpo).length === 0 && !faltanTags) return undefined;

  cuerpo.tags = deseados;

  try {
    const res = await fetchImpl(`${config.BASE_GHL}/contacts/${contactId}`, {
      method: 'PUT',
      headers: cabeceras(apiKey, config.VERSION_CONTACTOS),
      body: JSON.stringify(cuerpo),
    });
    if (!res.ok) return `GHL contacto ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function resumenParaNota(datos: Datos, canal: CanalEnvio): string {
  const etiquetas: Record<keyof Datos, string> = {
    nombre: 'Nombre', email: 'Correo', telefono: 'Teléfono',
    producto: 'Producto de interés', ubicacion: 'Ubicación',
  };

  const lineas = [`Conversación atendida por el agente automático (canal: ${canal}).`, ''];
  const faltan: string[] = [];

  for (const clave of Object.keys(etiquetas) as (keyof Datos)[]) {
    const valor = datos[clave];
    if (valor) lineas.push(`${etiquetas[clave]}: ${valor}`);
    else faltan.push(etiquetas[clave].toLowerCase());
  }

  if (faltan.length > 0) {
    lineas.push('', `Falta por confirmar: ${faltan.join(', ')}.`);
  }
  return lineas.join('\n');
}

export async function agregarNota(
  contactId: string, texto: string, deps: DepsEscritura,
): Promise<string | undefined> {
  const { apiKey, fetchImpl = fetch } = deps;
  try {
    const res = await fetchImpl(`${config.BASE_GHL}/contacts/${contactId}/notes`, {
      method: 'POST',
      headers: cabeceras(apiKey, config.VERSION_CONTACTOS),
      body: JSON.stringify({ body: texto }),
    });
    if (!res.ok) return `GHL nota ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function dispararWorkflow(
  contactId: string, deps: DepsEscritura,
): Promise<string | undefined> {
  const { apiKey, fetchImpl = fetch } = deps;
  try {
    const res = await fetchImpl(
      `${config.BASE_GHL}/contacts/${contactId}/workflow/${config.WORKFLOW_AVISO}`,
      {
        method: 'POST',
        headers: cabeceras(apiKey, config.VERSION_CONTACTOS),
        body: JSON.stringify({ eventStartTime: new Date().toISOString() }),
      },
    );
    if (!res.ok) return `GHL workflow ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
