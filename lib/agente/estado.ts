import type { Producto } from '@/lib/agente/config';

export type { Producto };

export type Datos = {
  nombre: string | null;
  email: string | null;
  telefono: string | null;
  producto: Producto | null;
  ubicacion: string | null;
};

export const DATOS_VACIOS: Datos = {
  nombre: null, email: null, telefono: null, producto: null, ubicacion: null,
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
  const { data } = await db.from(TABLA).select('*').eq('contact_id', contactId).maybeSingle();
  if (data) return { ...data, datos: { ...DATOS_VACIOS, ...(data.datos ?? {}) } } as Fila;

  const nueva = { contact_id: contactId, estado: 'activo', turnos: 0, datos: DATOS_VACIOS, enviados: [] };
  await db.from(TABLA).upsert(nueva, { onConflict: 'contact_id' });
  return { ...nueva, conversation_id: null, canal: null, ultimo_mensaje_id: null, notificado_at: null } as Fila;
}

// Guarda 3. UPDATE condicional: si la fila ya tiene registrado este mismo
// mensaje, no devuelve nada y el turno se abandona. Es lo que hace que un
// reintento de GHL no produzca una segunda respuesta al cliente.
export async function tomarMensaje(contactId: string, mensajeId: string, db: Db): Promise<boolean> {
  // El filtro `or` de PostgREST se construye como texto, así que una coma o un
  // paréntesis en el id lo partirían y cambiarían la condición. Los ids de GHL
  // son alfanuméricos; cualquier otra cosa es señal de algo raro y se rechaza
  // en vez de mandarse a la base.
  if (!/^[A-Za-z0-9_-]+$/.test(mensajeId)) {
    throw new Error(`[agente] Id de mensaje con forma inesperada: ${mensajeId.slice(0, 20)}`);
  }

  const { data } = await db
    .from(TABLA)
    .update({ ultimo_mensaje_id: mensajeId, updated_at: new Date().toISOString() })
    .eq('contact_id', contactId)
    // `neq` a secas no matchea NULL (en SQL `NULL <> 'x'` es NULL, no true),
    // así que una fila recién creada nunca podría reclamarse. El `or` con
    // `is.null` cubre ese caso.
    .or(`ultimo_mensaje_id.is.null,ultimo_mensaje_id.neq.${mensajeId}`)
    .select('contact_id');

  return Array.isArray(data) && data.length > 0;
}

export async function guardar(contactId: string, cambios: Partial<Fila>, db: Db): Promise<void> {
  await db
    .from(TABLA)
    .update({ ...cambios, updated_at: new Date().toISOString() })
    .eq('contact_id', contactId);
}
