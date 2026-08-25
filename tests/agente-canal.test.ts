import { describe, it, expect } from 'vitest';
import { esMensajeReal, canalDeEnvio, esCorreo } from '@/lib/agente/canal';

describe('esMensajeReal', () => {
  it('acepta los cuatro canales que el negocio atiende', () => {
    expect(esMensajeReal('TYPE_WHATSAPP')).toBe(true);
    expect(esMensajeReal('TYPE_INSTAGRAM')).toBe(true);
    expect(esMensajeReal('TYPE_FACEBOOK')).toBe(true);
    expect(esMensajeReal('TYPE_EMAIL')).toBe(true);
    expect(esMensajeReal('TYPE_CUSTOM_EMAIL')).toBe(true);
  });

  // Éste es EL caso. Sale de un sondeo real contra la location: una actividad
  // del CRM que GHL marca como inbound. Sin este filtro el agente cree que el
  // cliente escribió "DnD enabled by customer".
  it('rechaza las actividades del CRM aunque vengan marcadas inbound', () => {
    expect(esMensajeReal('TYPE_ACTIVITY_CONTACT')).toBe(false);
    expect(esMensajeReal('TYPE_ACTIVITY_OPPORTUNITY')).toBe(false);
    expect(esMensajeReal('TYPE_ACTIVITY_INVOICE')).toBe(false);
    expect(esMensajeReal('TYPE_ACTIVITY_PAYMENT')).toBe(false);
    expect(esMensajeReal('TYPE_ACTIVITY_APPOINTMENT')).toBe(false);
  });

  // Es allowlist y no blocklist a propósito: GHL puede añadir tipos nuevos
  // cuando quiera, y una blocklist quedaría desactualizada en silencio,
  // reintroduciendo exactamente el bug que este archivo existe para matar.
  it('rechaza cualquier tipo que no conozca, incluido uno inventado', () => {
    expect(esMensajeReal('TYPE_ACTIVITY_ALGO_QUE_NO_EXISTE_AUN')).toBe(false);
    expect(esMensajeReal('TYPE_CAMPAIGN_SMS')).toBe(false);
    expect(esMensajeReal('TYPE_CALL')).toBe(false);
    expect(esMensajeReal('TYPE_SMS')).toBe(false);
  });

  it('rechaza vacío, undefined y null sin reventar', () => {
    expect(esMensajeReal('')).toBe(false);
    expect(esMensajeReal(undefined)).toBe(false);
    expect(esMensajeReal(null)).toBe(false);
  });
});

describe('canalDeEnvio', () => {
  // El vocabulario de lectura y el de escritura son distintos en la misma API.
  // Mandar "TYPE_WHATSAPP" como type de envío es un 400.
  it('traduce el tipo leído al type que espera el endpoint de envío', () => {
    expect(canalDeEnvio('TYPE_WHATSAPP')).toBe('WhatsApp');
    expect(canalDeEnvio('TYPE_INSTAGRAM')).toBe('IG');
    expect(canalDeEnvio('TYPE_FACEBOOK')).toBe('FB');
    expect(canalDeEnvio('TYPE_EMAIL')).toBe('Email');
    expect(canalDeEnvio('TYPE_CUSTOM_EMAIL')).toBe('Email');
  });

  it('devuelve null para lo que no sabe enviar, en vez de adivinar', () => {
    expect(canalDeEnvio('TYPE_SMS')).toBeNull();
    expect(canalDeEnvio('TYPE_ACTIVITY_CONTACT')).toBeNull();
    expect(canalDeEnvio(undefined)).toBeNull();
  });
});

describe('esCorreo', () => {
  it('reconoce las dos variantes de correo', () => {
    expect(esCorreo('TYPE_EMAIL')).toBe(true);
    expect(esCorreo('TYPE_CUSTOM_EMAIL')).toBe(true);
  });

  it('no confunde mensajería con correo', () => {
    expect(esCorreo('TYPE_WHATSAPP')).toBe(false);
    expect(esCorreo(null)).toBe(false);
  });
});
