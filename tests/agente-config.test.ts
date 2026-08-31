import { describe, it, expect } from 'vitest';
import { config } from '@/lib/agente/config';

describe('config del agente', () => {
  it('expone el workflow de "Notificación interna (Respondió el email)"', () => {
    expect(config.WORKFLOW_EMAIL_RESPONDIDO).toBe('1235c311-b3e6-4b7d-be40-0ec2a1f01a60');
  });

  it('expone el workflow de "Cotización nueva"', () => {
    expect(config.WORKFLOW_COTIZACION_NUEVA).toBe('abfe1f24-e993-4963-ae8e-658142e8aa47');
  });

  it('topa las respuestas automáticas en 4', () => {
    expect(config.TOPE_TURNOS).toBe(4);
  });

  it('expone la clave del campo personalizado de la persona de contacto', () => {
    expect(config.CAMPO_PERSONA).toBe('contact.persona_contacto');
  });

  it('expone la etiqueta que calla al agente', () => {
    expect(config.ETIQUETA_STOP_BOT).toBe('Stop_bot');
  });

  it('tieneEtiquetaStopBot es insensible a mayúsculas', () => {
    expect(config.tieneEtiquetaStopBot(['Stop_bot'])).toBe(true);
    expect(config.tieneEtiquetaStopBot(['stop_bot'])).toBe(true);
    expect(config.tieneEtiquetaStopBot(['STOP_BOT'])).toBe(true);
  });

  it('tieneEtiquetaStopBot no se confunde con otras etiquetas', () => {
    expect(config.tieneEtiquetaStopBot(['otra-cosa'])).toBe(false);
    expect(config.tieneEtiquetaStopBot(['stop_bot_temporal'])).toBe(false);
    expect(config.tieneEtiquetaStopBot([])).toBe(false);
  });

  it('mapea cada producto a su tag, y null cuando no hay producto', () => {
    expect(config.tagDeProducto('uniformes')).toBe('interes-uniformes');
    expect(config.tagDeProducto('hogar')).toBe('interes-hogar');
    expect(config.tagDeProducto('ambas')).toBe('interes-ambas');
    expect(config.tagDeProducto(null)).toBeNull();
  });

  // El prompt se cachea en la API de Anthropic, y el mínimo de caché en Opus 5
  // son 512 TOKENS. Por debajo de eso el bloque no cachea y cada respuesta se
  // cobra completa, en silencio.
  //
  // El umbral en caracteres es un proxy calibrado con una medición real contra
  // /v1/messages/count_tokens: 2153 caracteres de este prompt = 948 tokens, o
  // sea ~2.3 chars/token (el español tokeniza peor que el inglés; la regla de
  // ~4 chars/token es de inglés y aquí sobreestima por casi el doble).
  // 512 tokens ≈ 1160 caracteres, así que 1500 deja margen cómodo.
  it('el prompt es lo bastante largo para que la caché lo acepte', () => {
    expect(config.PROMPT_SISTEMA.length).toBeGreaterThan(1500);
  });

  it('el prompt le prohíbe inventar precios y plazos', () => {
    const p = config.PROMPT_SISTEMA.toLowerCase();
    expect(p).toContain('precio');
    expect(p).toContain('plazo');
    expect(p).toContain('nunca');
  });
});
