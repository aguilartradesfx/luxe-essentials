import { describe, it, expect, vi } from 'vitest';
import { escribirContactoSinPisar } from '@/lib/ghl-contacto';

const deps = { apiKey: 'llave' };

function contactoYPut(actual: Record<string, unknown>) {
  return vi
    .fn()
    .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ contact: actual }) })
    .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' });
}

// Este módulo es la única fuente de la regla "no pisar un contacto de GHL":
// la usan tanto el agente conversacional (vía `actualizarContacto`, ver
// tests/agente-acciones.test.ts, que ya cubre nombre/email/telefono) como el
// cotizador (vía `resolverContacto`, ver tests/cotizador-ghl.test.ts). Estas
// pruebas cubren directamente las ramas que sólo usa el cotizador —
// `empresa` y `source` — para que ningún llamador nuevo pueda saltárselas.
describe('escribirContactoSinPisar', () => {
  it('rellena companyName y source cuando están vacíos', async () => {
    const fetchImpl = contactoYPut({});
    await escribirContactoSinPisar(
      'c1',
      { empresa: 'Hotel Papagayo', source: 'Cotizador Luxe Essentials' },
      [],
      { ...deps, fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(body.companyName).toBe('Hotel Papagayo');
    expect(body.source).toBe('Cotizador Luxe Essentials');
  });

  it('no pisa companyName ni source si el contacto ya los tenía', async () => {
    const fetchImpl = contactoYPut({ companyName: 'Razón Social Real S.A.', source: 'Importacion ERP 2026' });
    await escribirContactoSinPisar(
      'c1',
      { empresa: 'Hotel Papagayo', source: 'Cotizador Luxe Essentials' },
      ['cotizacion'],
      { ...deps, fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect('companyName' in body).toBe(false);
    expect('source' in body).toBe(false);
  });

  it('nunca escribe city, ni siquiera si está vacío', async () => {
    const fetchImpl = contactoYPut({});
    await escribirContactoSinPisar('c1', { nombre: 'Ana' }, [], { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect('city' in body).toBe(false);
  });

  it('suma los tags nuevos a los que ya tenía, sin reemplazarlos', async () => {
    const fetchImpl = contactoYPut({ tags: ['base-2026', 'zona-caribe'] });
    await escribirContactoSinPisar('c1', {}, ['cotizacion'], { ...deps, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(body.tags).toEqual(expect.arrayContaining(['base-2026', 'zona-caribe', 'cotizacion']));
    expect(body.tags).toHaveLength(3);
  });

  it('no repite un tag que ya estaba', async () => {
    const fetchImpl = contactoYPut({ tags: ['cotizacion'] });
    await escribirContactoSinPisar('c1', {}, ['cotizacion'], { ...deps, fetchImpl });
    // Sin nada que rellenar y sin tags nuevos por sumar, no hace falta el PUT.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('no escribe si no hay campos ni tags nuevos', async () => {
    const fetchImpl = contactoYPut({ email: 'ya@estaba.com' });
    await escribirContactoSinPisar('c1', { email: 'otro@x.com' }, [], { ...deps, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('no escribe si no pudo leer el contacto', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const err = await escribirContactoSinPisar('c1', { nombre: 'Ana' }, ['x'], { ...deps, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(err).toBeTruthy();
  });

  it('devuelve el error del PUT sin lanzar', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ contact: {} }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    const err = await escribirContactoSinPisar('c1', { nombre: 'Ana' }, [], { ...deps, fetchImpl });
    expect(err).toContain('500');
  });

  it('no lanza si se cae la red', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const err = await escribirContactoSinPisar('c1', { nombre: 'Ana' }, [], { ...deps, fetchImpl });
    expect(err).toContain('ECONNRESET');
  });
});
