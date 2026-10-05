import { describe, it, expect } from 'vitest';
import {
  AYUDA_ENTREGA,
  ESTADOS_ENTREGA,
  ETIQUETAS_ENTREGA,
  estadoDeEntrega,
  esEstadoEntrega,
  pastillaDeEntrega,
} from '@/lib/campanas/estado-entrega';

describe('estadoDeEntrega', () => {
  it('un correo recién salido (sin evento) es «sin confirmar», NO fallido', () => {
    expect(estadoDeEntrega({ estado: 'enviado', entrega_estado: null })).toBe('sin_confirmar');
    expect(estadoDeEntrega({ estado: 'enviado', entrega_estado: 'enviado' })).toBe('sin_confirmar');
  });
  it('traduce cada estado de entrega al suyo', () => {
    expect(estadoDeEntrega({ estado: 'enviado', entrega_estado: 'retrasado' })).toBe('retrasado');
    expect(estadoDeEntrega({ estado: 'enviado', entrega_estado: 'entregado' })).toBe('entregado');
    expect(estadoDeEntrega({ estado: 'enviado', entrega_estado: 'rebotado' })).toBe('rebotado');
    expect(estadoDeEntrega({ estado: 'enviado', entrega_estado: 'fallido' })).toBe('fallido');
    expect(estadoDeEntrega({ estado: 'enviado', entrega_estado: 'queja' })).toBe('queja');
  });
  it('un envío que Resend no aceptó es «no salió», distinto de «fallido» y de «sin confirmar»', () => {
    expect(estadoDeEntrega({ estado: 'error', entrega_estado: null })).toBe('no_salio');
  });
  it('esEstadoEntrega sólo acepta los siete', () => {
    for (const e of ESTADOS_ENTREGA) expect(esEstadoEntrega(e)).toBe(true);
    expect(esEstadoEntrega('spam')).toBe(false);
    expect(esEstadoEntrega(undefined)).toBe(false);
  });
});

describe('pastillaDeEntrega', () => {
  it('cada estado se pinta distinto de los demás: texto y color', () => {
    const pastillas = ESTADOS_ENTREGA.map((e) => pastillaDeEntrega(e));
    expect(new Set(pastillas.map((p) => p.texto)).size).toBe(ESTADOS_ENTREGA.length);
    expect(new Set(pastillas.map((p) => p.clase)).size).toBe(ESTADOS_ENTREGA.length);
  });
  it('el texto de la pastilla es el rótulo del estado', () => {
    for (const e of ESTADOS_ENTREGA) expect(pastillaDeEntrega(e).texto).toBe(ETIQUETAS_ENTREGA[e]);
  });
});

describe('lo que la pantalla NO puede afirmar', () => {
  const todo = [...Object.values(ETIQUETAS_ENTREGA), ...Object.values(AYUDA_ENTREGA)];

  it('ningún rótulo ni ayuda dice que el correo «cayó en spam» o «fue a spam»', () => {
    for (const t of todo) {
      expect(t).not.toMatch(/cay[oó]\s+en\s+(la\s+)?(carpeta\s+de\s+)?(spam|correo no deseado)/i);
      expect(t).not.toMatch(/(fue|va|iba)\s+a\s+(la\s+)?(carpeta\s+de\s+)?spam/i);
    }
    expect(Object.values(ETIQUETAS_ENTREGA).join(' ')).not.toMatch(/^spam$|cay/i);
  });

  it('«queja» se dice como lo que es: la persona lo marcó como spam, recibido en su bandeja', () => {
    expect(ETIQUETAS_ENTREGA.queja).toMatch(/lo marc[oó] como spam/i);
    expect(AYUDA_ENTREGA.queja).toMatch(/recibi[oó] en su bandeja/i);
    expect(AYUDA_ENTREGA.queja).toMatch(/no es lo mismo que haber ca[ií]do en la carpeta de spam/i);
  });

  it('«entregado» aclara que no dice si quedó en la bandeja o en spam', () => {
    expect(AYUDA_ENTREGA.entregado).toMatch(/no dice/i);
  });

  it('«sin confirmar» aclara que no es un fallo', () => {
    expect(AYUDA_ENTREGA.sin_confirmar).toMatch(/no significa que haya fallado/i);
  });
});
