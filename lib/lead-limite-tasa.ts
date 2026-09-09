import 'server-only';

// Limite de tasa por IP para /api/lead (I9, revision-final-2.md). Vive en
// la base (supabase/migrations/0025_lead_limite_tasa.sql), no en memoria:
// cada instancia de Vercel tiene su propia memoria de proceso, asi que un
// contador en memoria no limita nada -- la siguiente peticion del mismo
// atacante puede caer en otra instancia con el contador en cero.
//
// Mismo tipo laxo que `Db` en lib/cotizador/usuarios.ts: permite probar la
// logica sin un cliente real de Supabase.
export type Db = {
  rpc: (nombre: string, argumentos: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>;
};

const RPC = 'lead_limite_tasa_incrementar';

// Ventana de 10 minutos, tope de 5 peticiones por IP.
//
// Por que estos numeros: una persona real manda el formulario UNA vez. Si
// se equivoca en un campo (el correo mal escrito, un select vacio), lo
// reintenta -- dos, tres intentos como mucho, casi siempre en el mismo
// minuto. El caso mas exigente es una IP compartida de verdad: el front
// desk de un hotel, donde dos o tres personas distintas pueden mandar el
// formulario casi al mismo tiempo por la misma salida a internet. Cinco
// peticiones en diez minutos cubre esos dos casos con margen de sobra sin
// que nadie note que existe un limite.
//
// Un script que manda el formulario en bucle, en cambio, queda cortado a
// partir de la sexta peticion en esos diez minutos -- de "mil contactos
// basura en un rato" pasa a, como mucho, treinta por hora contra la misma
// cuota de GoHighLevel de la que depende el agente de WhatsApp en vivo.
// No es la unica capa (honeypot y comprobacion de origen paran antes a la
// mayoria de los bots tontos que de verdad preocupan aca): es la que no
// depende de que el bot ejecute JavaScript o respete un campo oculto.
export const VENTANA_SEGUNDOS = 600;
export const TOPE_POR_VENTANA = 5;

// `true` si la peticion entra dentro del limite, `false` si ya lo superó.
//
// No lanza, y si la base falla (RPC caida, credenciales, timeout) se deja
// PASAR -- mismo criterio que el resto del proyecto (ver el comentario de
// `registrarFallo` en lib/cotizador/usuarios.ts): un problema de
// infraestructura en el contador no debe tumbar el formulario real de
// captacion de clientes. El caso degradado es "sin limite", no "sin
// formulario".
export async function dentroDelLimite(db: Db, ip: string, ahora: Date = new Date()): Promise<boolean> {
  const { data, error } = await db.rpc(RPC, {
    p_ip: ip,
    p_ahora: ahora.toISOString(),
    p_ventana_segundos: VENTANA_SEGUNDOS,
    p_tope: TOPE_POR_VENTANA,
  });
  if (error) {
    console.error('[lead] No se pudo comprobar el límite de tasa; se deja pasar.', error.message);
    return true;
  }
  return data === true;
}

// La IP tal como la ve Vercel: `x-forwarded-for` lleva, de izquierda a
// derecha, el cliente original y despues cada proxy que reenvió la
// peticion -- el primer valor es el que importa. Sin la cabecera (cliente
// que no la manda, entorno local) se agrupan todas esas peticiones bajo
// un mismo cubo fijo en vez de saltarse el limite -- fail-closed para el
// caso raro, no fail-open.
export function ipDeLaPeticion(request: Request): string {
  const crudo = request.headers.get('x-forwarded-for');
  if (!crudo) return 'ip-desconocida';
  return crudo.split(',')[0]!.trim() || 'ip-desconocida';
}
