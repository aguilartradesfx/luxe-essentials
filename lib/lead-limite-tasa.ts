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

// De que cabecera sale la IP, y por que el orden importa.
//
// `x-forwarded-for` es la cabecera clasica, pero la manda el CLIENTE y
// los proxies le van agregando valores por la izquierda. Si Vercel le
// AGREGA la IP real en vez de reemplazar la cabecera entera, entonces
// tomar el primer valor es tomar exactamente lo que el atacante escribio:
// manda `x-forwarded-for: <IP al azar>` en cada peticion, cae en un cubo
// distinto cada vez, y el limite no limita nada. Es la forma clasica de
// saltarse un limite por IP.
//
// Por eso se piden primero las dos cabeceras que pone la propia red de
// Vercel y que NO se pueden falsificar desde afuera -- Vercel descarta
// las `x-vercel-*` que vengan del cliente antes de que la funcion las
// vea. `x-forwarded-for` queda de ultimo recurso, para que esto tambien
// funcione detras de otro proxy o en local.
//
// No se comprobo cual de las tres manda Vercel en esta cuenta: el orden
// esta puesto para que la respuesta correcta gane sin importar cual sea.
export function ipDeLaPeticion(request: Request): string {
  for (const cabecera of ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for']) {
    const crudo = request.headers.get(cabecera);
    if (!crudo) continue;
    // Cualquiera de las tres puede traer una lista; el primer valor es el
    // cliente original y los siguientes son los proxies que reenviaron.
    const primera = crudo.split(',')[0]!.trim();
    if (primera) return primera;
  }
  // Sin ninguna de las tres (cliente que no las manda, entorno local) se
  // agrupan todas esas peticiones bajo un mismo cubo fijo en vez de
  // saltarse el limite -- fail-closed para el caso raro, no fail-open.
  return 'ip-desconocida';
}
