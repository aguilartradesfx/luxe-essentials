import { describe, it, expect, beforeEach } from 'vitest';

const { POST } = await import('@/app/api/cotizacion/catalogo/route');

function peticion(cuerpo: unknown) {
  return new Request('http://localhost/api/cotizacion/catalogo', {
    method: 'POST',
    body: JSON.stringify(cuerpo),
  });
}

describe('POST /api/cotizacion/catalogo', () => {
  beforeEach(() => {
    process.env.LUXE_TALLER_CLAVE = 'secreta';
  });

  it('rechaza sin clave', async () => {
    const res = await POST(peticion({}));
    expect(res.status).toBe(401);
  });

  it('rechaza con clave incorrecta', async () => {
    const res = await POST(peticion({ clave: 'otra' }));
    expect(res.status).toBe(401);
  });

  it('rechaza un cuerpo que no es JSON', async () => {
    const res = await POST(
      new Request('http://localhost/api/cotizacion/catalogo', { method: 'POST', body: 'no soy json' }),
    );
    expect(res.status).toBe(400);
  });

  it('con la clave correcta, ningún SKU trae precio ni grupo de descuento', async () => {
    // Este es el hallazgo que motivó la Tarea 8: `CATALOGO` completo lleva
    // `precioLista` y `grupo` (la estructura de márgenes por volumen), y este
    // endpoint es el único punto donde ese catálogo toca una respuesta HTTP.
    // La proyección se afirma sobre las CLAVES REALES del objeto devuelto,
    // no sobre un ejemplo — así, si alguien cambia el `.map` para devolver
    // el SKU entero (o agrega `precioLista` de vuelta a la proyección), esta
    // prueba se pone roja sin importar qué SKU sea el primero.
    const res = await POST(peticion({ clave: 'secreta' }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(Array.isArray(cuerpo.skus)).toBe(true);
    expect(cuerpo.skus.length).toBeGreaterThan(0);

    for (const sku of cuerpo.skus) {
      expect(Object.keys(sku).sort()).toEqual(['familia', 'id', 'nombre']);
    }

    // Doble comprobación, más legible en el mensaje de fallo si alguna vez
    // se rompe: ni "precioLista" ni "grupo" aparecen en ningún SKU devuelto.
    const camposFiltrados = cuerpo.skus.some(
      (sku: Record<string, unknown>) => 'precioLista' in sku || 'grupo' in sku,
    );
    expect(camposFiltrados).toBe(false);
  });

  it('devuelve el mismo número de SKUs que el catálogo real', async () => {
    const { CATALOGO } = await import('@/lib/cotizador/catalogo');
    const res = await POST(peticion({ clave: 'secreta' }));
    const cuerpo = await res.json();
    expect(cuerpo.skus).toHaveLength(CATALOGO.length);
  });
});
