// tests/campanas-entrega.test.ts
//
// lib/campanas/entrega.ts: la firma de Svix, la lectura del evento y los
// envoltorios de las rpc. La LÓGICA de base (repetido, desordenado,
// desconocido, totales) vive en SQL -- migración 0029 -- y se verifica
// contra la base real, dentro de una transacción revertida, con
// scripts/verificar-resend-webhook.mjs. Nunca se llama a Resend.
import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  firmaSvixValida,
  leerEventoResend,
  registrarEventoResend,
  reconciliarEventosHuerfanos,
  totalesEntregaPorCampana,
  TOLERANCIA_FIRMA_SEGUNDOS,
} from '@/lib/campanas/entrega';

const CLAVE = Buffer.from('una-clave-de-prueba-de-32-bytes!!');
const SECRETO = `whsec_${CLAVE.toString('base64')}`;
const AHORA_S = 1_790_000_000;
const AHORA_MS = AHORA_S * 1000;

function firmar(id: string, ts: string | number, cuerpo: string, clave: Buffer = CLAVE) {
  return `v1,${createHmac('sha256', clave).update(`${id}.${ts}.${cuerpo}`).digest('base64')}`;
}
const CUERPO = '{"type":"email.delivered","created_at":"2026-10-01T10:00:00.000Z","data":{"email_id":"abc"}}';

describe('firmaSvixValida', () => {
  const base = () => ({ id: 'msg_1', timestamp: String(AHORA_S), cuerpo: CUERPO, secreto: SECRETO, ahoraMs: AHORA_MS });

  it('acepta una firma correcta', () => {
    const e = base();
    expect(firmaSvixValida({ ...e, firma: firmar(e.id, e.timestamp, e.cuerpo) })).toBe(true);
  });

  // Mata al mutante que use el secreto SIN decodificar el base64 como clave.
  it('la clave es el base64 DECODIFICADO: una firma hecha con el texto del secreto no vale', () => {
    const e = base();
    expect(firmaSvixValida({ ...e, firma: firmar(e.id, e.timestamp, e.cuerpo, Buffer.from(SECRETO)) })).toBe(false);
  });

  // Mata al mutante que no incluya el cuerpo (o lo re-serialice) al firmar.
  it('un cuerpo alterado en un solo byte no valida', () => {
    const e = base();
    expect(firmaSvixValida({ ...e, cuerpo: CUERPO.replace('abc', 'abd'), firma: firmar(e.id, e.timestamp, e.cuerpo) })).toBe(false);
  });

  it('el id y la marca de tiempo forman parte de lo firmado', () => {
    const e = base();
    const firma = firmar(e.id, e.timestamp, e.cuerpo);
    expect(firmaSvixValida({ ...e, id: 'msg_2', firma })).toBe(false);
    expect(firmaSvixValida({ ...e, timestamp: String(AHORA_S + 1), firma })).toBe(false);
  });

  // Mata al mutante que borre el chequeo de antigüedad.
  it('rechaza una marca de tiempo vieja aunque la firma sea perfecta', () => {
    const e = base();
    const ts = String(AHORA_S - TOLERANCIA_FIRMA_SEGUNDOS - 1);
    expect(firmaSvixValida({ ...e, timestamp: ts, firma: firmar(e.id, ts, e.cuerpo) })).toBe(false);
  });

  it('rechaza una marca de tiempo del futuro', () => {
    const e = base();
    const ts = String(AHORA_S + TOLERANCIA_FIRMA_SEGUNDOS + 1);
    expect(firmaSvixValida({ ...e, timestamp: ts, firma: firmar(e.id, ts, e.cuerpo) })).toBe(false);
  });

  it('acepta en el borde de la tolerancia', () => {
    const e = base();
    const ts = String(AHORA_S - TOLERANCIA_FIRMA_SEGUNDOS);
    expect(firmaSvixValida({ ...e, timestamp: ts, firma: firmar(e.id, ts, e.cuerpo) })).toBe(true);
  });

  it('una marca de tiempo que no son sólo dígitos no vale', () => {
    const e = base();
    for (const ts of ['', '0x10', '1e3', ' 1790000000', '1790000000.5', 'abc']) {
      expect(firmaSvixValida({ ...e, timestamp: ts, firma: firmar(e.id, ts, e.cuerpo) })).toBe(false);
    }
  });

  // Falla cerrada: sin secreto, NADA pasa -- ni siquiera una "firma" hecha
  // con una clave vacía.
  it('sin secreto, falla cerrada aunque la firma coincida con una clave vacía', () => {
    const e = base();
    const firmaClaveVacia = firmar(e.id, e.timestamp, e.cuerpo, Buffer.alloc(0));
    expect(firmaSvixValida({ ...e, secreto: '', firma: firmaClaveVacia })).toBe(false);
    expect(firmaSvixValida({ ...e, secreto: 'whsec_', firma: firmaClaveVacia })).toBe(false);
  });

  it('faltan cabeceras: no vale', () => {
    const e = base();
    const firma = firmar(e.id, e.timestamp, e.cuerpo);
    expect(firmaSvixValida({ ...e, id: null, firma })).toBe(false);
    expect(firmaSvixValida({ ...e, timestamp: null, firma })).toBe(false);
    expect(firmaSvixValida({ ...e, firma: null })).toBe(false);
  });

  // Durante una rotación de secreto la cabecera trae dos firmas; basta con
  // que UNA (cualquiera) sea buena. Mata al mutante que sólo mire la primera.
  it('con varias entradas v1, vale si cualquiera coincide (también la segunda)', () => {
    const e = base();
    const mala = firmar(e.id, e.timestamp, e.cuerpo, Buffer.from('otra-clave-distinta-de-32-bytes!'));
    const buena = firmar(e.id, e.timestamp, e.cuerpo);
    expect(firmaSvixValida({ ...e, firma: `${mala} ${buena}` })).toBe(true);
    expect(firmaSvixValida({ ...e, firma: `${buena} ${mala}` })).toBe(true);
    expect(firmaSvixValida({ ...e, firma: `${mala} ${mala}` })).toBe(false);
  });

  it('una entrada con otra versión (v2) no cuenta, aunque su valor sea el correcto', () => {
    const e = base();
    expect(firmaSvixValida({ ...e, firma: firmar(e.id, e.timestamp, e.cuerpo).replace('v1,', 'v2,') })).toBe(false);
  });

  it('una firma de largo equivocado no revienta (timingSafeEqual)', () => {
    const e = base();
    expect(firmaSvixValida({ ...e, firma: 'v1,AAAA' })).toBe(false);
    expect(firmaSvixValida({ ...e, firma: 'v1,' })).toBe(false);
    expect(firmaSvixValida({ ...e, firma: 'basura' })).toBe(false);
  });
});

describe('leerEventoResend', () => {
  const evento = (type: string, extra: Record<string, unknown> = {}, data: Record<string, unknown> = {}) =>
    JSON.stringify({
      type,
      created_at: '2026-10-01T10:00:05.000Z',
      data: { email_id: 'em_1', created_at: '2026-10-01T09:00:00.000Z', ...data },
      ...extra,
    });

  it('lee los ocho tipos que nos importan', () => {
    for (const t of ['email.sent', 'email.delivered', 'email.delivery_delayed', 'email.bounced', 'email.complained', 'email.failed', 'email.opened', 'email.clicked']) {
      expect(leerEventoResend(evento(t), 0)?.tipo).toBe(t);
    }
  });

  // Mata al mutante que tome `data.created_at` (la hora en que se creó el
  // CORREO) en vez del `created_at` de la raíz (la hora del EVENTO): el
  // orden de los eventos se decide con esa hora.
  it('la hora del evento es la de la raíz, no la de data.created_at', () => {
    expect(leerEventoResend(evento('email.delivered'), 0)!.ocurridoAt).toBe('2026-10-01T10:00:05.000Z');
  });

  it('sin created_at legible, cae a la hora de la cabecera svix-timestamp', () => {
    const cuerpo = JSON.stringify({ type: 'email.delivered', data: { email_id: 'em_1' } });
    expect(leerEventoResend(cuerpo, 1_790_000_000)!.ocurridoAt).toBe(new Date(1_790_000_000_000).toISOString());
  });

  it('otros tipos de evento (dominios, contactos, recibidos) se ignoran', () => {
    expect(leerEventoResend(evento('domain.updated'), 0)).toBeNull();
    expect(leerEventoResend(evento('email.received'), 0)).toBeNull();
  });

  it('JSON roto o sin email_id: null, no revienta', () => {
    expect(leerEventoResend('no es json', 0)).toBeNull();
    expect(leerEventoResend('null', 0)).toBeNull();
    expect(leerEventoResend(JSON.stringify({ type: 'email.sent', data: {} }), 0)).toBeNull();
  });

  it('guarda el detalle del rebote y del clic, y recorta lo largo', () => {
    const r = leerEventoResend(evento('email.bounced', {}, { bounce: { type: 'Permanent', subType: 'General', message: 'x'.repeat(500) } }), 0)!;
    expect(r.detalle).toMatchObject({ bounce_tipo: 'Permanent', bounce_subtipo: 'General' });
    expect(r.detalle!.mensaje).toHaveLength(200);
    expect(leerEventoResend(evento('email.clicked', {}, { click: { link: 'https://luxe.cr/x' } }), 0)!.detalle).toEqual({ enlace: 'https://luxe.cr/x' });
    expect(leerEventoResend(evento('email.delivered'), 0)!.detalle).toBeNull();
  });
});

describe('registrarEventoResend / reconciliar / totales', () => {
  const ev = { tipo: 'email.delivered' as const, resendId: 'em_1', ocurridoAt: '2026-10-01T10:00:00.000Z', detalle: null };

  it('llama a la rpc con el svix-id como clave de idempotencia y devuelve su veredicto', async () => {
    const db = { from: vi.fn(), rpc: vi.fn(async () => ({ data: 'duplicado', error: null })) };
    expect(await registrarEventoResend(db as any, 'msg_9', ev)).toBe('duplicado');
    expect(db.rpc).toHaveBeenCalledWith('resend_registrar_evento', {
      p_svix_id: 'msg_9', p_tipo: 'email.delivered', p_resend_id: 'em_1', p_ocurrido_at: ev.ocurridoAt, p_detalle: null,
    });
  });

  it('un error de la base se propaga (para que el webhook responda 500 y Svix reintente)', async () => {
    const db = { from: vi.fn(), rpc: vi.fn(async () => ({ data: null, error: { message: 'caida' } })) };
    await expect(registrarEventoResend(db as any, 'msg_9', ev)).rejects.toThrow(/caida/);
  });

  it('una respuesta que no es ninguno de los tres veredictos es un error, no un exito mudo', async () => {
    const db = { from: vi.fn(), rpc: vi.fn(async () => ({ data: null, error: null })) };
    await expect(registrarEventoResend(db as any, 'msg_9', ev)).rejects.toThrow();
  });

  it('reconciliarEventosHuerfanos devuelve cuántos aplicó', async () => {
    const db = { from: vi.fn(), rpc: vi.fn(async () => ({ data: 3, error: null })) };
    expect(await reconciliarEventosHuerfanos(db as any)).toBe(3);
    expect(db.rpc).toHaveBeenCalledWith('resend_reconciliar_huerfanos', {});
  });

  it('totalesEntregaPorCampana: una lectura de la tabla de totales; las campañas sin eventos dan ceros', async () => {
    const inFn = vi.fn(async () => ({
      data: [{ campana_id: 'c-1', entregados: 90, rebotados: 4, quejas: 1, fallidos: 0, abiertos: 30, clics: 2 }],
      error: null,
    }));
    const db = { rpc: vi.fn(), from: vi.fn(() => ({ select: () => ({ in: inFn }) })) };
    const r = await totalesEntregaPorCampana(db as any, ['c-1', 'c-2']);
    expect(db.from).toHaveBeenCalledTimes(1);
    expect(db.from).toHaveBeenCalledWith('campanas_entrega_totales');
    expect(r['c-1']).toEqual({ entregados: 90, rebotados: 4, quejas: 1, fallidos: 0, abiertos: 30, clics: 2 });
    expect(r['c-2']).toEqual({ entregados: 0, rebotados: 0, quejas: 0, fallidos: 0, abiertos: 0, clics: 0 });
  });
});
