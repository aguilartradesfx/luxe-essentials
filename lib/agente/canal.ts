// GHL devuelve, mezclados en el mismo array, los mensajes de canal y las
// actividades del CRM. Algunas actividades vienen marcadas `inbound`, así que
// filtrar por dirección no basta: hay que filtrar por tipo.
//
// Esto es una allowlist, no una blocklist, a propósito. GHL añade tipos de
// actividad nuevos sin avisar; una blocklist envejecería en silencio y el
// agente volvería a responderle a un evento del CRM creyendo que es un cliente.

export const TIPOS_REALES = [
  'TYPE_WHATSAPP',
  'TYPE_INSTAGRAM',
  'TYPE_FACEBOOK',
  'TYPE_EMAIL',
  'TYPE_CUSTOM_EMAIL',
] as const;

export type TipoReal = (typeof TIPOS_REALES)[number];
export type CanalEnvio = 'WhatsApp' | 'IG' | 'FB' | 'Email';

export function esMensajeReal(tipo: string | undefined | null): tipo is TipoReal {
  return !!tipo && (TIPOS_REALES as readonly string[]).includes(tipo);
}

// El tipo que se LEE no es el type que se ENVÍA: son dos vocabularios distintos
// de la misma API. Mandar "TYPE_WHATSAPP" al endpoint de envío es un 400.
const ENVIO: Record<TipoReal, CanalEnvio> = {
  TYPE_WHATSAPP: 'WhatsApp',
  TYPE_INSTAGRAM: 'IG',
  TYPE_FACEBOOK: 'FB',
  TYPE_EMAIL: 'Email',
  TYPE_CUSTOM_EMAIL: 'Email',
};

export function canalDeEnvio(tipo: string | undefined | null): CanalEnvio | null {
  return esMensajeReal(tipo) ? ENVIO[tipo] : null;
}

// Se deriva del diccionario en vez de repetir la lista: un tipo de correo nuevo
// que se añadiera arriba y se olvidara aquí produciría una conversación de
// cuatro turnos por correo en lugar de la respuesta única que el diseño quiere.
export function esCorreo(tipo: string | undefined | null): boolean {
  return canalDeEnvio(tipo) === 'Email';
}
