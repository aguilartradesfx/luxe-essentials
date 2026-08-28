// tests/panel-almacen.test.ts
import { describe, it, expect, vi } from 'vitest';
import { guardarPdf, enlaceFirmado } from '@/lib/cotizador/almacen';

function almacen(resultadoSubida: unknown, resultadoUrl?: unknown) {
  const upload = vi.fn().mockResolvedValue(resultadoSubida);
  const createSignedUrl = vi.fn().mockResolvedValue(resultadoUrl ?? { data: null, error: null });
  return { cliente: { storage: { from: () => ({ upload, createSignedUrl }) } }, upload, createSignedUrl };
}

const pdf = Buffer.from('%PDF-1.7 falso');

describe('guardarPdf', () => {
  it('sube el PDF y devuelve su ruta', async () => {
    const a = almacen({ data: { path: 'x' }, error: null });
    const r = await guardarPdf({ id: 'abc', numero: 'COT-2026-0001', pdf }, a.cliente);
    expect(r).toEqual({ ok: true, ruta: expect.stringContaining('COT-2026-0001') });
  });

  it('organiza por año y usa el id para que la ruta no sea adivinable', async () => {
    const a = almacen({ data: { path: 'x' }, error: null });
    const r = await guardarPdf({ id: 'abc123', numero: 'COT-2026-0001', pdf }, a.cliente);
    if (!r.ok) throw new Error('debía subir');
    expect(r.ruta).toMatch(/^\d{4}\//);
    expect(r.ruta).toContain('abc123');
  });

  it('sube con el tipo de contenido correcto', async () => {
    const a = almacen({ data: { path: 'x' }, error: null });
    await guardarPdf({ id: 'abc', numero: 'COT-1', pdf }, a.cliente);
    expect(a.upload.mock.calls[0][2]).toMatchObject({ contentType: 'application/pdf' });
  });

  it('devuelve el error sin lanzar', async () => {
    const a = almacen({ data: null, error: { message: 'bucket lleno' } });
    const r = await guardarPdf({ id: 'abc', numero: 'COT-1', pdf }, a.cliente);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('bucket lleno') });
  });

  it('no lanza si el almacenamiento explota', async () => {
    const cliente = { storage: { from: () => { throw new Error('sin red'); } } };
    const r = await guardarPdf({ id: 'abc', numero: 'COT-1', pdf }, cliente);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('sin red') });
  });
});

describe('enlaceFirmado', () => {
  it('devuelve la url firmada', async () => {
    const a = almacen({}, { data: { signedUrl: 'https://x/firmada' }, error: null });
    const r = await enlaceFirmado('2026/abc.pdf', a.cliente);
    expect(r).toEqual({ ok: true, url: 'https://x/firmada' });
  });

  it('firma por 90 días por defecto', async () => {
    const a = almacen({}, { data: { signedUrl: 'https://x' }, error: null });
    await enlaceFirmado('2026/abc.pdf', a.cliente);
    expect(a.createSignedUrl.mock.calls[0][1]).toBe(90 * 24 * 60 * 60);
  });

  it('devuelve el error sin lanzar', async () => {
    const a = almacen({}, { data: null, error: { message: 'ruta inexistente' } });
    const r = await enlaceFirmado('no/existe.pdf', a.cliente);
    expect(r.ok).toBe(false);
  });
});
