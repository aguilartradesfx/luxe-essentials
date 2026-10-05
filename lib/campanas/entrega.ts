import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ClienteCampanas } from '@/lib/campanas/envio';

// Qué pasó con cada correo DESPUÉS de salir -- el webhook de Resend.
// El diseño completo (rastro + estado actual + totales) está en el
// comentario de la migración 0029 (supabase/migrations/0029_resend_eventos.sql).
//
// QUÉ NO SE SABE: Resend no sabe si un correo cayó en la carpeta de spam;
// nadie lo sabe desde afuera. `queja` (email.complained) es otra cosa --
// el destinatario lo marcó como spam DESPUÉS de recibirlo. Ninguna etiqueta
// de este módulo dice «cayó en spam».

// ---------------------------------------------------------------------
// 1) La firma (Svix, lo que usa Resend).
//
// Resend firma con Svix: cabeceras `svix-id`, `svix-timestamp`,
// `svix-signature`. La firma es HMAC-SHA256 sobre `${id}.${timestamp}.${cuerpo}`
// en base64, y la cabecera trae una o varias entradas `v1,<firma>` separadas
// por espacio (varias durante una rotación de secreto). El secreto viene
// como `whsec_<base64>` y la clave del HMAC es ese base64 DECODIFICADO.
// El cuerpo es el texto CRUDO tal cual llegó -- re-serializar el JSON
// cambiaría bytes y la firma nunca coincidiría.

// Marcas de tiempo a más de 5 minutos de distancia (hacia atrás O hacia
// adelante) se rechazan: acota la ventana en la que una captura de red
// robada serviría para reenviar un evento.
export const TOLERANCIA_FIRMA_SEGUNDOS = 300;

export type EntradaFirma = {
  id: string | null;
  timestamp: string | null;
  firma: string | null;
  cuerpo: string;
  secreto: string;
  ahoraMs?: number;
};

export function firmaSvixValida({ id, timestamp, firma, cuerpo, secreto, ahoraMs = Date.now() }: EntradaFirma): boolean {
  if (!secreto || !id || !timestamp || !firma) return false;

  // Sólo dígitos: `Number('')`, `Number('0x10')`, `Number('1e3')` colarían
  // marcas de tiempo raras.
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const segundos = Number(timestamp);
  if (Math.abs(ahoraMs / 1000 - segundos) > TOLERANCIA_FIRMA_SEGUNDOS) return false;

  const base64 = secreto.startsWith('whsec_') ? secreto.slice('whsec_'.length) : secreto;
  const clave = Buffer.from(base64, 'base64');
  if (clave.length === 0) return false;

  const esperada = createHmac('sha256', clave).update(`${id}.${timestamp}.${cuerpo}`).digest();

  for (const entrada of firma.split(' ')) {
    const [version, valor] = entrada.split(',');
    if (version !== 'v1' || !valor) continue;
    const recibida = Buffer.from(valor, 'base64');
    // `timingSafeEqual` revienta si los largos difieren: se compara el
    // largo ANTES (mismo criterio que app/api/ghl/webhook/route.ts).
    if (recibida.length === esperada.length && timingSafeEqual(recibida, esperada)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// 2) Leer el evento.

export const TIPOS_EVENTO_RESEND = [
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.bounced',
  'email.complained',
  'email.failed',
  'email.opened',
  'email.clicked',
] as const;
export type TipoEventoResend = (typeof TIPOS_EVENTO_RESEND)[number];

export type EventoResend = {
  tipo: TipoEventoResend;
  resendId: string;
  ocurridoAt: string; // ISO -- la hora del EVENTO (top-level `created_at`), no la de llegada.
  detalle: Record<string, string> | null;
};

// `null` si el cuerpo no es un evento que nos sirva (otro tipo de evento de
// Resend -- dominios, contactos --, JSON roto, falta el id del correo).
// `recibidoEnSegundos` (la cabecera `svix-timestamp`, ya validada) es la
// hora de respaldo si el evento no trae `created_at` legible.
export function leerEventoResend(cuerpo: string, recibidoEnSegundos: number): EventoResend | null {
  let json: unknown;
  try {
    json = JSON.parse(cuerpo);
  } catch {
    return null;
  }
  const c = json as {
    type?: unknown;
    created_at?: unknown;
    data?: {
      email_id?: unknown;
      bounce?: { type?: unknown; subType?: unknown; message?: unknown };
      click?: { link?: unknown };
      failed?: { reason?: unknown };
    };
  };
  if (typeof c?.type !== 'string' || !(TIPOS_EVENTO_RESEND as readonly string[]).includes(c.type)) return null;
  const emailId = c.data?.email_id;
  if (typeof emailId !== 'string' || !emailId.trim()) return null;

  // OJO: `data.created_at` es la hora en que se CREÓ el correo, no la del
  // evento -- la del evento es `created_at` en la raíz.
  let ocurrido = typeof c.created_at === 'string' ? new Date(c.created_at) : new Date(NaN);
  if (Number.isNaN(ocurrido.getTime())) ocurrido = new Date(recibidoEnSegundos * 1000);

  const detalle: Record<string, string> = {};
  const b = c.data?.bounce;
  if (typeof b?.type === 'string') detalle.bounce_tipo = b.type.slice(0, 40);
  if (typeof b?.subType === 'string') detalle.bounce_subtipo = b.subType.slice(0, 40);
  if (typeof b?.message === 'string') detalle.mensaje = b.message.slice(0, 200);
  if (typeof c.data?.failed?.reason === 'string') detalle.mensaje = c.data.failed.reason.slice(0, 200);
  if (typeof c.data?.click?.link === 'string') detalle.enlace = c.data.click.link.slice(0, 300);

  return {
    tipo: c.type as TipoEventoResend,
    resendId: emailId.trim(),
    ocurridoAt: ocurrido.toISOString(),
    detalle: Object.keys(detalle).length > 0 ? detalle : null,
  };
}

// ---------------------------------------------------------------------
// 3) Guardarlo -- UNA sola llamada a la base (rpc `resend_registrar_evento`,
// migración 0029): deduplica por `svix-id`, guarda en el rastro y actualiza
// estado y totales de forma atómica. Ver su comentario sobre el orden.
export type ResultadoRegistro = 'aplicado' | 'duplicado' | 'huerfano';

export async function registrarEventoResend(
  db: ClienteCampanas,
  svixId: string,
  evento: EventoResend,
): Promise<ResultadoRegistro> {
  const { data, error } = await db.rpc('resend_registrar_evento', {
    p_svix_id: svixId,
    p_tipo: evento.tipo,
    p_resend_id: evento.resendId,
    p_ocurrido_at: evento.ocurridoAt,
    p_detalle: evento.detalle,
  });
  if (error) throw new Error(`No se pudo registrar el evento de Resend: ${error.message}`);
  if (data !== 'aplicado' && data !== 'duplicado' && data !== 'huerfano') {
    throw new Error(`Respuesta inesperada al registrar el evento de Resend: ${String(data)}`);
  }
  return data;
}

// Enlaza y aplica los eventos que llegaron antes de que el envío tuviera su
// `resend_id` (ver migración 0029). Retorna cuántos aplicó.
export async function reconciliarEventosHuerfanos(db: ClienteCampanas): Promise<number> {
  const { data, error } = await db.rpc('resend_reconciliar_huerfanos', {});
  if (error) throw new Error(`No se pudieron reconciliar los eventos huerfanos: ${error.message}`);
  return Number(data ?? 0);
}

// ---------------------------------------------------------------------
// 4) Consultar -- para la pantalla que se construye después.

export type TotalesEntrega = {
  entregados: number;
  rebotados: number;
  // email.complained: el destinatario lo marcó como spam DESPUÉS de
  // recibirlo. NO es "cayó en la carpeta de spam" (eso no se puede medir).
  quejas: number;
  fallidos: number;
  abiertos: number;
  clics: number;
};

export const TOTALES_ENTREGA_VACIOS: TotalesEntrega = {
  entregados: 0, rebotados: 0, quejas: 0, fallidos: 0, abiertos: 0, clics: 0,
};

// Un contador por campaña, leído de `campanas_entrega_totales` (una fila
// por campaña) -- nunca se cuenta fila por fila. Las campañas sin
// ningún evento todavía no tienen fila: devuelven ceros.
export async function totalesEntregaPorCampana(
  db: ClienteCampanas,
  campanaIds: string[],
): Promise<Record<string, TotalesEntrega>> {
  const salida: Record<string, TotalesEntrega> = {};
  for (const id of campanaIds) salida[id] = { ...TOTALES_ENTREGA_VACIOS };
  if (campanaIds.length === 0) return salida;

  const { data, error } = await db
    .from('campanas_entrega_totales')
    .select('campana_id, entregados, rebotados, quejas, fallidos, abiertos, clics')
    .in('campana_id', campanaIds);
  if (error) throw new Error(`No se pudieron leer los totales de entrega: ${error.message}`);
  for (const f of (data ?? []) as Array<TotalesEntrega & { campana_id: string }>) {
    salida[f.campana_id] = {
      entregados: Number(f.entregados) || 0,
      rebotados: Number(f.rebotados) || 0,
      quejas: Number(f.quejas) || 0,
      fallidos: Number(f.fallidos) || 0,
      abiertos: Number(f.abiertos) || 0,
      clics: Number(f.clics) || 0,
    };
  }
  return salida;
}

export type EstadoEntrega = 'enviado' | 'retrasado' | 'entregado' | 'rebotado' | 'fallido' | 'queja';

// Los envíos de una campaña cuyo ESTADO ACTUAL de entrega es `estado` --
// el filtro "mostrame los rebotados" -- sin tocar el rastro de eventos.
export async function enviosPorEstadoDeEntrega(
  db: ClienteCampanas,
  campanaId: string,
  estado: EstadoEntrega,
  limite = 200,
): Promise<Array<{ id: string; correo: string; nombre_crm: string; entrega_evento_at: string | null; entrega_detalle: string | null }>> {
  const { data, error } = await db
    .from('campanas_envios')
    .select('id, correo, nombre_crm, entrega_evento_at, entrega_detalle')
    .eq('campana_id', campanaId)
    .eq('entrega_estado', estado)
    .limit(limite);
  if (error) throw new Error(`No se pudieron leer los envios por estado de entrega: ${error.message}`);
  return (data ?? []) as Array<{ id: string; correo: string; nombre_crm: string; entrega_evento_at: string | null; entrega_detalle: string | null }>;
}
