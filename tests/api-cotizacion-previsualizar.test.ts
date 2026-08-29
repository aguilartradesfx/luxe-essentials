import { describe, it, expect, beforeEach } from 'vitest';

const { POST } = await import('@/app/api/cotizacion/previsualizar/route');
const { emitirSesion } = await import('@/lib/sesion');

function peticion(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return new Request('http://localhost/api/cotizacion/previsualizar', {
    method: 'POST',
    headers: cabeceras,
    body: JSON.stringify(cuerpo),
  });
}

// Fase 3: la clave compartida ya no autentica. Ruta de solo lectura: la
// cookie de sesión basta, sin token anti-CSRF.
function peticionAutenticada(cuerpo: unknown) {
  const { cookie } = emitirSesion('Guillermo Rojas');
  return peticion(cuerpo, { cookie: cookie.split(';')[0] });
}

const valido = {
  lineas: [{ skuId: 'set-600-king', cantidad: 16 }],
};

describe('POST /api/cotizacion/previsualizar', () => {
  beforeEach(() => {
    process.env.LUXE_TALLER_CLAVE = 'secreta';
  });

  it('rechaza sin sesión', async () => {
    const res = await POST(peticion(valido));
    expect(res.status).toBe(401);
  });

  it('rechaza sin sesión antes de mirar la forma del cuerpo (401, no 400)', async () => {
    // Mismo criterio que en tests/api-cotizacion.test.ts: un cuerpo
    // estructuralmente roto sin sesión debe dar 401 sin que Zod llegue a
    // mirarlo — si el orden se invirtiera, esto daría 400 y filtraría la
    // forma esperada del cuerpo a quien no tiene credencial.
    const res = await POST(peticion({ lineas: 'no soy un arreglo' }));
    expect(res.status).toBe(401);
  });

  it('rechaza un cuerpo que no es JSON', async () => {
    const res = await POST(
      new Request('http://localhost/api/cotizacion/previsualizar', { method: 'POST', body: 'no soy json' }),
    );
    expect(res.status).toBe(400);
  });

  it('con sesión pero un cuerpo que no cumple el esquema, da 400', async () => {
    const res = await POST(peticionAutenticada({ lineas: 'no soy un arreglo' }));
    expect(res.status).toBe(400);
  });

  it('traduce un error de calcular() (SKU inexistente) a 400, no a un 500', async () => {
    const res = await POST(peticionAutenticada({ lineas: [{ skuId: 'fantasma', cantidad: 1 }] }));
    expect(res.status).toBe(400);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(false);
  });

  it('previsualiza con el carrito vacío (total en cero), sin exigir al menos una línea', async () => {
    // A diferencia de `cotizacionSchema` (envío final), este esquema no
    // exige `.min(1)`: la pantalla previsualiza también antes de agregar el
    // primer producto.
    const res = await POST(peticionAutenticada({ lineas: [] }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.cotizacion.total).toBe(0);
  });

  it('devuelve el motivo y el precio unitario reales que produce el motor para 16 sets de 600 hilos king', async () => {
    // Esta es la prueba que ata a la realidad tanto este endpoint como el
    // mock de tests/cotizador-ui.test.tsx: si alguien mueve el escalón de 16
    // a otro número, cambia el porcentaje, o cambia la redacción del
    // `motivo`, esta prueba se pone roja — no solo la simulación de la
    // pantalla, que podría seguir "pasando" con datos inventados.
    const res = await POST(peticionAutenticada(valido));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.cotizacion.lineas).toHaveLength(1);
    const [linea] = cuerpo.cotizacion.lineas;
    expect(linea.skuId).toBe('set-600-king');
    expect(linea.descuentoPct).toBe(10);
    expect(linea.precioUnitario).toBe(81000);
    expect(linea.motivo).toBe('16 sets en Sets de cama → 10%');
  });

  it('acepta una tasa de IVA distinta y la refleja en el total', async () => {
    const res = await POST(peticionAutenticada({ ...valido, tasaIva: 0 }));
    const cuerpo = await res.json();
    expect(cuerpo.cotizacion.tasaIva).toBe(0);
    expect(cuerpo.cotizacion.iva).toBe(0);
  });

  it('no guarda nada: no hay id ni referencia a una fila en la respuesta', async () => {
    const res = await POST(peticionAutenticada(valido));
    const cuerpo = await res.json();
    expect(cuerpo.id).toBeUndefined();
  });
});
