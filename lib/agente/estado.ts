import type { Producto } from '@/lib/agente/config';

export type { Producto };

export type Datos = {
  nombre: string | null;
  email: string | null;
  telefono: string | null;
  producto: Producto | null;
  ubicacion: string | null;
  cantidad: string | null;
};

export const DATOS_VACIOS: Datos = {
  nombre: null, email: null, telefono: null, producto: null, ubicacion: null, cantidad: null,
};

export type EstadoAgente = 'activo' | 'humano' | 'agotado' | 'email_respondido';

export type Fila = {
  contact_id: string;
  conversation_id: string | null;
  canal: string | null;
  estado: EstadoAgente;
  turnos: number;
  datos: Datos;
  ultimo_mensaje_id: string | null;
  procesando_hasta: string | null;
  enviados: string[];
  notificado_at: string | null;
};

// El cliente que devuelve supabaseAdmin(). Se inyecta para poder probar sin
// base de datos, igual que fetchImpl en lib/ghl.ts.
export type Db = { from: (tabla: string) => any };

const TABLA = 'agente_conversaciones';

export function fusionarDatos(previos: Datos, nuevos: Partial<Datos>): Datos {
  const fusionado = { ...previos };
  for (const clave of Object.keys(DATOS_VACIOS) as (keyof Datos)[]) {
    const valor = nuevos[clave];
    // Un null o una cadena en blanco significan "no lo supe en este turno",
    // no "bórralo". El modelo devuelve el objeto entero cada vez, así que sin
    // esta condición perderíamos el correo del cliente en el turno siguiente.
    if (typeof valor === 'string' && valor.trim() !== '') {
      (fusionado[clave] as string) = valor.trim();
    }
  }
  return fusionado;
}

export async function leerOCrear(contactId: string, db: Db): Promise<Fila> {
  const { data, error } = await db.from(TABLA).select('*').eq('contact_id', contactId).maybeSingle();

  // Un error de lectura NO puede confundirse con "contacto nuevo". Supabase
  // devuelve data null en ambos casos, y tratarlo como fila fresca sería grave:
  // un contacto ya marcado 'humano' o 'agotado' volvería a parecer 'activo' con
  // los turnos a cero, y el agente empezaría a hablar otra vez sobre una
  // conversación que un asesor ya había tomado. Se lanza para que el fallo se
  // vea en el log del webhook en vez de convertirse en un bot indeseado.
  if (error) {
    throw new Error(`[agente] No se pudo leer el estado de ${contactId}: ${error.message}`);
  }

  if (data) return { ...data, datos: { ...DATOS_VACIOS, ...(data.datos ?? {}) } } as Fila;

  // `ignoreDuplicates` es obligatorio: un upsert normal PISA la fila si otra
  // invocación la creó entre nuestro select y este insert, y la pisaría con
  // estado 'activo', turnos 0 y enviados vacío. En la ventana de dos webhooks
  // simultáneos para el primer mensaje de un contacto que un asesor ya está
  // atendiendo, eso resucitaría un contacto recién marcado 'humano'.
  const nueva = { contact_id: contactId, estado: 'activo', turnos: 0, datos: DATOS_VACIOS, enviados: [] };
  const { error: errorAlta } = await db
    .from(TABLA)
    .upsert(nueva, { onConflict: 'contact_id', ignoreDuplicates: true });
  if (errorAlta) {
    throw new Error(`[agente] No se pudo crear el estado de ${contactId}: ${errorAlta.message}`);
  }

  // Si otra invocación ganó la creación, la fila real puede no ser la nuestra.
  // Se relee para no devolver un estado inventado.
  const { data: real, error: errorRelectura } = await db
    .from(TABLA)
    .select('*')
    .eq('contact_id', contactId)
    .maybeSingle();
  // Misma razón que la primera lectura: un fallo aquí devolvería en silencio la
  // fila fabricada 'activo'/turnos 0, que es justo lo que puede resucitar a un
  // contacto ya marcado 'humano'.
  if (errorRelectura) {
    throw new Error(`[agente] No se pudo releer el estado de ${contactId}: ${errorRelectura.message}`);
  }
  if (real) return { ...real, datos: { ...DATOS_VACIOS, ...(real.datos ?? {}) } } as Fila;

  return {
    ...nueva,
    conversation_id: null,
    canal: null,
    ultimo_mensaje_id: null,
    procesando_hasta: null,
    notificado_at: null,
  } as Fila;
}

// Guarda 3. UPDATE condicional: si la fila ya tiene registrado este mismo
// mensaje, no devuelve nada y el turno se abandona. Es lo que hace que un
// reintento de GHL no produzca una segunda respuesta al cliente.
// Ventana del arriendo. Un turno completo (hidratar, transcribir, generar,
// enviar) ronda los 5-20 s; 90 s deja margen sin dejar un contacto bloqueado
// mucho rato si el proceso muere a mitad.
const ARRIENDO_SEGUNDOS = 90;

export async function tomarMensaje(contactId: string, mensajeId: string, db: Db): Promise<boolean> {
  // El filtro `or` de PostgREST se construye como texto, así que una coma o un
  // paréntesis en el id lo partirían y cambiarían la condición. Los ids de GHL
  // son alfanuméricos; cualquier otra cosa es señal de algo raro y se rechaza
  // en vez de mandarse a la base.
  if (!/^[A-Za-z0-9_-]+$/.test(mensajeId)) {
    throw new Error(`[agente] Id de mensaje con forma inesperada: ${mensajeId.slice(0, 20)}`);
  }

  const ahora = new Date();
  const hasta = new Date(ahora.getTime() + ARRIENDO_SEGUNDOS * 1000).toISOString();

  const { data, error } = await db
    .from(TABLA)
    .update({
      ultimo_mensaje_id: mensajeId,
      procesando_hasta: hasta,
      updated_at: ahora.toISOString(),
    })
    .eq('contact_id', contactId)
    // `neq` a secas no matchea NULL (en SQL `NULL <> 'x'` es NULL, no true),
    // así que una fila recién creada nunca podría reclamarse. El `or` con
    // `is.null` cubre ese caso. Esto deduplica el MISMO mensaje.
    .or(`ultimo_mensaje_id.is.null,ultimo_mensaje_id.neq.${mensajeId}`)
    // Y esto serializa el CONTACTO. Sin esta segunda condición, un cliente que
    // manda "hola" y luego "quiero uniformes" —lo normal en WhatsApp— genera
    // dos webhooks con ids distintos que reclaman cada uno el suyo y corren en
    // paralelo: el cliente recibe dos respuestas, y las dos escrituras de
    // estado pisan la misma lectura perdiendo el id de un enviado. Ese id
    // perdido hace que al turno siguiente el propio saliente del agente parezca
    // de un humano y el contacto quede mudo para siempre.
    //
    // Los dos `or` se combinan con AND: PostgREST une con AND los parámetros
    // repetidos. El valor va entre comillas porque un timestamp ISO lleva
    // puntos y dos puntos, que son separadores del filtro.
    .or(`procesando_hasta.is.null,procesando_hasta.lt."${ahora.toISOString()}"`)
    .select('contact_id');

  // Un fallo de base NO es lo mismo que "otro proceso ya lo tomó". Devolver
  // false aquí haría que el agente se saltara en silencio el mensaje de un
  // cliente real — que es exactamente el silencio que este proyecto existe para
  // evitar, y encima indistinguible de un duplicado legítimo en los logs.
  if (error) {
    throw new Error(`[agente] Falló el candado de ${contactId}: ${error.message}`);
  }

  return Array.isArray(data) && data.length > 0;
}

// Devuelve el mensaje de error en vez de tragárselo, para que quien llama pueda
// decidir. No lanza: hay llamadas —las de después de enviar— donde al cliente ya
// se le respondió y hacer fallar el turno no desharía ese envío. Pero hay otra
// —el latch de 'humano'— donde perder la escritura significa que el agente puede
// volver a hablarle encima a un asesor, y ésa sí necesita enterarse.
export async function guardar(
  contactId: string, cambios: Partial<Fila>, db: Db,
): Promise<string | undefined> {
  const { error } = await db
    .from(TABLA)
    .update({ ...cambios, updated_at: new Date().toISOString() })
    .eq('contact_id', contactId);

  if (error) {
    console.error('[agente] No se pudo guardar el estado.', 'contacto:', contactId, error.message);
    return error.message;
  }
  return undefined;
}
