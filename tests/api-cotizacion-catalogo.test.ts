import { describe, it, expect, beforeEach } from 'vitest';

const { POST } = await import('@/app/api/cotizacion/catalogo/route');
const { emitirSesion } = await import('@/lib/sesion');

function peticion(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return new Request('http://localhost/api/cotizacion/catalogo', {
    method: 'POST',
    headers: cabeceras,
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

  // --- Ronda de correcciones 1 (Tarea 9, hallazgo crítico) ---
  //
  // Esta ruta es la sonda que usa `Panel.tsx` para saber si ya hay una
  // sesión viva al montar: si la cookie es válida, también devuelve el
  // token anti-CSRF que le corresponde, para que una pestaña nueva (o el
  // navegador reabierto) no dependa de `sessionStorage` —por pestaña, se
  // pierde al cerrarla— para recuperar un token que la cookie, de 30 días,
  // ya demuestra que le pertenece.
  describe('token anti-CSRF en la respuesta cuando la entrada es por cookie', () => {
    beforeEach(() => {
      process.env.LUXE_TALLER_CLAVE = 'secreta';
    });

    it('con cookie válida y sin clave, la respuesta trae el csrf que le corresponde a esa cookie', async () => {
      const { cookie, csrf } = emitirSesion();
      const valor = cookie.split(';')[0];
      const res = await POST(peticion({}, { cookie: valor }));
      expect(res.status).toBe(200);
      const cuerpo = await res.json();
      expect(cuerpo.csrf).toBe(csrf);
    });

    it('con clave correcta y sin cookie, la respuesta NO trae csrf (no hay sesión de la que derivarlo)', async () => {
      const res = await POST(peticion({ clave: 'secreta' }));
      expect(res.status).toBe(200);
      const cuerpo = await res.json();
      expect('csrf' in cuerpo).toBe(false);
    });

    it('con clave correcta Y cookie válida, la respuesta también trae el csrf (depende de la cookie, no de cómo se autenticó)', async () => {
      // Ronda de correcciones 2 (hallazgo menor): `csrfDeSesion` no mira
      // `autenticarPeticion` ni cómo pasó la petición — solo si la cookie
      // presentada es válida. Mandar además una clave correcta no cambia
      // eso. Sin impacto de seguridad (quien ya tiene la cookie válida no
      // gana ninguna capacidad nueva), pero el reporte de la ronda anterior
      // decía "nunca por la vía de la clave", que esta prueba desmiente.
      const { cookie, csrf } = emitirSesion();
      const valor = cookie.split(';')[0];
      const res = await POST(peticion({ clave: 'secreta' }, { cookie: valor }));
      expect(res.status).toBe(200);
      const cuerpo = await res.json();
      expect(cuerpo.csrf).toBe(csrf);
    });

    it('con Sec-Fetch-Site: cross-site, no devuelve el csrf aunque la cookie sea válida', async () => {
      // Endurecimiento a propósito: hoy un sitio ajeno no puede LEER esta
      // respuesta (sin cabecera Access-Control-Allow-Origin, es opaca para
      // su JavaScript), pero este chequeo no depende de que eso siga siendo
      // cierto para siempre. La petición en sí sigue pasando (200, con los
      // SKUs) — lo único que se retiene es el token.
      const { cookie } = emitirSesion();
      const valor = cookie.split(';')[0];
      const res = await POST(peticion({}, { cookie: valor, 'sec-fetch-site': 'cross-site' }));
      expect(res.status).toBe(200);
      const cuerpo = await res.json();
      expect(cuerpo.ok).toBe(true);
      expect('csrf' in cuerpo).toBe(false);
    });

    it('con Sec-Fetch-Site: same-origin, sí devuelve el csrf (uso normal del panel)', async () => {
      const { cookie, csrf } = emitirSesion();
      const valor = cookie.split(';')[0];
      const res = await POST(peticion({}, { cookie: valor, 'sec-fetch-site': 'same-origin' }));
      const cuerpo = await res.json();
      expect(cuerpo.csrf).toBe(csrf);
    });
  });
});
