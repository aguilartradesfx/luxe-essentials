import { config } from '@/lib/agente/config';
import type { CanalEnvio } from '@/lib/agente/canal';
import type { Datos } from '@/lib/agente/estado';
import { escribirContactoSinPisar } from '@/lib/ghl-contacto';

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

// Mismo criterio de reintento que usa `hidratar` en conversacion.ts: un
// intento, y sólo uno más, ante un fallo de red o un 5xx. Un 4xx no se
// reintenta — un problema de permisos o de parámetros no mejora insistiendo,
// y aquí encima el cliente estaría esperando mientras tanto. Se mantiene una
// copia local en vez de importar la de conversacion.ts porque esa función
// arma sus propias cabeceras (versión de conversaciones, GET siempre); acá
// hace falta variar versión de API, método y cuerpo según el llamador
// (`leerContacto` es GET, `dispararWorkflow` es POST con body), así que
// `intentar` recibe el fetch entero ya armado y esta función sólo decide
// cuándo repetirlo.
async function conReintento(intentar: () => Promise<Response>): Promise<Response> {
  try {
    const res = await intentar();
    if (res.status < 500) return res;
  } catch {
    // Cae al reintento de abajo. Si ese también falla, lo recoge el
    // try/catch de quien llama.
  }
  await new Promise((r) => setTimeout(r, 400));
  return intentar();
}

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

    const datos = JSON.parse(texto) as { messageId?: string; id?: string };
    const messageId = datos.messageId ?? datos.id ?? null;

    // Sin id no podemos registrar el mensaje en `enviados`, así que en el
    // siguiente turno la guarda 2 verá nuestro propio saliente como ajeno y
    // callará el contacto de forma permanente. Es el único caso en que esa
    // guarda se equivoca, y sin esta línea no dejaría ningún rastro.
    if (!messageId) {
      console.error(
        '[agente] GHL no devolvió messageId; la guarda del humano podría callar al agente.',
        'contacto:', p.contactId,
      );
    }

    return { ok: true, messageId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Lo que el contacto ya tenía en GoHighLevel ANTES de este turno: sus
// etiquetas (para la guarda de `config.ETIQUETA_STOP_BOT`) y el nombre,
// correo y teléfono de su ficha, para que el cerebro pueda CONFIRMARLOS en
// vez de preguntarlos desde cero (ver `cerebro.ts` y el prompt del sistema).
// `nombre` combina firstName + lastName porque así es como lo maneja
// `Datos.nombre` (lib/agente/estado.ts) y como se le pide al modelo.
export type FichaContacto = {
  etiquetas: string[];
  nombre: string | null;
  email: string | null;
  telefono: string | null;
};

// Lee el contacto en GoHighLevel: etiquetas, nombre, correo y teléfono. La
// usa `procesar.ts` para decidir si el agente debe callarse por
// `config.ETIQUETA_STOP_BOT` y para pasarle al cerebro lo que la ficha ya
// traía. Es una sola llamada HTTP — antes sólo se leían las etiquetas y se
// tiraba el resto de la respuesta, así que ampliar lo que se devuelve no
// cuesta ninguna llamada adicional. Nunca lanza: devuelve el error para que
// quien llama decida qué hacer con la lectura fallida (ver procesar.ts para
// la decisión que toma).
//
// Reintenta una vez ante un 5xx o un fallo de red (ver `conReintento` arriba):
// antes no reintentaba nada, así que un 429/500 pasajero de GHL dejaba al
// cliente sin respuesta sin que nada lo intentara de nuevo — `hidratar`, que
// corre justo al lado en el mismo turno, sí reintenta desde el principio.
export async function leerContacto(
  contactId: string, deps: DepsEscritura,
): Promise<{ ok: true } & FichaContacto | { ok: false; error: string }> {
  const { apiKey, fetchImpl = fetch } = deps;
  try {
    const res = await conReintento(() => fetchImpl(`${config.BASE_GHL}/contacts/${contactId}`, {
      headers: cabeceras(apiKey, config.VERSION_CONTACTOS),
    }));
    const texto = await res.text();
    if (!res.ok) return { ok: false, error: `GHL lectura de contacto ${res.status}: ${texto.slice(0, 200)}` };

    const datos = JSON.parse(texto) as {
      contact?: { tags?: unknown; firstName?: unknown; lastName?: unknown; email?: unknown; phone?: unknown };
    };
    const contacto = datos.contact ?? {};
    const tags = contacto.tags;

    const primero = typeof contacto.firstName === 'string' ? contacto.firstName.trim() : '';
    const apellido = typeof contacto.lastName === 'string' ? contacto.lastName.trim() : '';
    const nombre = [primero, apellido].filter(Boolean).join(' ') || null;
    const email = typeof contacto.email === 'string' && contacto.email.trim() ? contacto.email.trim() : null;
    const telefono = typeof contacto.phone === 'string' && contacto.phone.trim() ? contacto.phone.trim() : null;

    return {
      ok: true,
      etiquetas: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [],
      nombre, email, telefono,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Nunca lanza: un fallo guardando los datos no debe borrar el hecho de que al
// cliente ya se le respondió. Devuelve el texto del error para el log.
//
// La lectura-antes-de-escribir, el "sólo rellena vacíos", el nunca-city y el
// campo de persona viven en `lib/ghl-contacto.ts` — es la misma lógica que
// usa `resolverContacto` en `lib/cotizador/ghl.ts`, para no duplicarla una
// tercera vez con reglas distintas (esa duplicación fue justo el hallazgo
// C2 de la revisión final).
export async function actualizarContacto(
  contactId: string, datos: Datos, deps: DepsEscritura,
): Promise<string | undefined> {
  // Sin ningún dato no hay nada que escribir, y ni siquiera vale la pena leer.
  const hayAlgo = Object.values(datos).some(Boolean);
  if (!hayAlgo) return undefined;

  const tagProducto = config.tagDeProducto(datos.producto);
  return escribirContactoSinPisar(
    contactId,
    { nombre: datos.nombre, email: datos.email, telefono: datos.telefono },
    [...config.TAGS_BASE, ...(tagProducto ? [tagProducto] : [])],
    deps,
  );
}

export function resumenParaNota(datos: Datos, canal: CanalEnvio): string {
  const etiquetas: Record<keyof Datos, string> = {
    nombre: 'Nombre', email: 'Correo', telefono: 'Teléfono',
    producto: 'Producto de interés', ubicacion: 'Ubicación',
    cantidad: 'Cantidad estimada',
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

// GoHighLevel exige "un date and time con desfase horario", con este
// ejemplo exacto en el propio mensaje de error: `2021-06-23T03:30:00+01:00`.
// `Date.prototype.toISOString()` no sirve: pone `Z` en vez del desfase
// explícito y arrastra milisegundos, y GHL responde 422 a ambas cosas (visto
// en producción). Como aquí siempre trabajamos en UTC, el desfase es
// siempre `+00:00` — nunca `Z`, nunca `.mmm`.
//
// `toISOString()` en sí es determinista (siempre UTC, sin importar la zona
// horaria de la máquina donde corra Node), así que basta con reescribir su
// cola: cambiar `.SSSZ` por `+00:00`.
export function horaEventoGHL(ahora: Date = new Date()): string {
  return ahora.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

// `workflowId` es un parámetro y no una constante interna porque este agente
// dispara más de un workflow: el aviso interno al equipo desde procesar.ts
// (config.WORKFLOW_AVISO_INTERNO) y el de "Cotización nueva" desde
// app/api/cotizacion/route.ts (config.WORKFLOW_COTIZACION_NUEVA). Cada
// llamador decide cuál.
//
// `POST /contacts/{id}/workflow/{workflowId}` mete al contacto DIRECTO en el
// workflow y SE SALTA cualquier trigger configurado en la interfaz de
// GoHighLevel. Por eso nadie debe configurar ahí, además, un trigger para el
// mismo evento — el resultado serían dos disparos del mismo aviso.
export async function dispararWorkflow(
  contactId: string, workflowId: string, deps: DepsEscritura,
): Promise<string | undefined> {
  const { apiKey, fetchImpl = fetch } = deps;
  try {
    const res = await fetchImpl(
      `${config.BASE_GHL}/contacts/${contactId}/workflow/${workflowId}`,
      {
        method: 'POST',
        headers: cabeceras(apiKey, config.VERSION_CONTACTOS),
        body: JSON.stringify({ eventStartTime: horaEventoGHL() }),
      },
    );
    if (!res.ok) return `GHL workflow ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
