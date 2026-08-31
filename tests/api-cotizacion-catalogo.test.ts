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

// Fase 3: la clave compartida ya no autentica. Ruta de solo lectura: la
// cookie de sesión basta, sin token anti-CSRF.
function peticionAutenticada(cuerpo: unknown) {
  const { cookie } = emitirSesion('Guillermo Rojas', 'vendedor', 'aaaaaaaa-0000-4000-8000-000000000001');
  return peticion(cuerpo, { cookie: cookie.split(';')[0] });
}

describe('POST /api/cotizacion/catalogo', () => {
  beforeEach(() => {
    process.env.LUXE_SESION_SECRETO = 'secreta';
  });

  it('rechaza sin sesión', async () => {
    const res = await POST(peticion({}));
    expect(res.status).toBe(401);
  });

  // Fase 3: la clave compartida ya no es una credencial — mandar cualquier
  // valor en `clave` (correcto o no, del formato anterior) no cambia nada:
  // sin cookie sigue dando 401.
  it('rechaza una clave en el cuerpo, sin sesión', async () => {
    const res = await POST(peticion({ clave: 'otra' }));
    expect(res.status).toBe(401);
  });

  it('rechaza un cuerpo que no es JSON', async () => {
    const res = await POST(
      new Request('http://localhost/api/cotizacion/catalogo', { method: 'POST', body: 'no soy json' }),
    );
    expect(res.status).toBe(400);
  });

  it('con sesión válida, ningún SKU trae precio ni grupo de descuento', async () => {
    // Este es el hallazgo que motivó la Tarea 8: `CATALOGO` completo lleva
    // `precioLista` y `grupo` (la estructura de márgenes por volumen), y este
    // endpoint es el único punto donde ese catálogo toca una respuesta HTTP.
    // La proyección se afirma sobre las CLAVES REALES del objeto devuelto,
    // no sobre un ejemplo — así, si alguien cambia el `.map` para devolver
    // el SKU entero (o agrega `precioLista` de vuelta a la proyección), esta
    // prueba se pone roja sin importar qué SKU sea el primero.
    const res = await POST(peticionAutenticada({}));
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
    const res = await POST(peticionAutenticada({}));
    const cuerpo = await res.json();
    expect(cuerpo.skus).toHaveLength(CATALOGO.length);
  });

  // Tarea 5 (usuarios del panel): `Panel.tsx` usa esta misma ruta como
  // sonda de sesión al montar y como verificación tras `/entrar` — en
  // ninguno de los dos casos vuelve a pasar por `/entrar`, así que el
  // nombre del vendedor solo puede llegarle desde acá.
  it('devuelve el vendedor de la sesión junto al token', async () => {
    const { cookie } = emitirSesion('Guillermo Rojas', 'vendedor', 'aaaaaaaa-0000-4000-8000-000000000001');
    const res = await POST(peticion({}, { cookie: cookie.split(';')[0] }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.vendedor).toBe('Guillermo Rojas');
  });

  // Tarea 3 (invitaciones y roles): la respuesta de esta ruta es también de
  // donde el panel obtiene el rol de la sesión (para decidir qué dibujar).
  it('devuelve el rol de la sesión junto al vendedor', async () => {
    const { cookie } = emitirSesion('Guillermo Rojas', 'superadmin', 'aaaaaaaa-0000-4000-8000-000000000001');
    const res = await POST(peticion({}, { cookie: cookie.split(';')[0] }));
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.rol).toBe('superadmin');
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
      process.env.LUXE_SESION_SECRETO = 'secreta';
    });

    it('con cookie válida y sin clave, la respuesta trae el csrf que le corresponde a esa cookie', async () => {
      const { cookie, csrf } = emitirSesion('Guillermo Rojas', 'vendedor', 'aaaaaaaa-0000-4000-8000-000000000001');
      const valor = cookie.split(';')[0];
      const res = await POST(peticion({}, { cookie: valor }));
      expect(res.status).toBe(200);
      const cuerpo = await res.json();
      expect(cuerpo.csrf).toBe(csrf);
    });

    // Fase 3 (hallazgo de esta tarea): esta prueba comprobaba que autenticar
    // por clave, sin cookie, daba 200 pero sin csrf (no hay sesión de la que
    // derivarlo). Esa vía ya no existe — la clave dejó de ser una credencial,
    // así que el mismo cuerpo ahora da 401, no 200. No hay forma de conservar
    // el escenario original (200 sin csrf) sin una sesión: se reemplaza por
    // la prueba que sí describe el comportamiento actual.
    it('sin cookie, una clave en el cuerpo ya no autentica: 401 y sin csrf', async () => {
      const res = await POST(peticion({ clave: 'secreta' }));
      expect(res.status).toBe(401);
      const cuerpo = await res.json();
      expect('csrf' in cuerpo).toBe(false);
    });

    it('una clave en el cuerpo no interfiere con la cookie: sigue trayendo el csrf que le corresponde', async () => {
      // Ronda de correcciones 2 (hallazgo menor): `csrfDeSesion` no mira
      // `autenticarPeticion` ni cómo pasó la petición — solo si la cookie
      // presentada es válida. Mandar además una clave (aunque ya no
      // autentique nada) no cambia eso: un campo de sobra en el cuerpo no
      // debe tumbar una sesión por cookie que sí es válida.
      const { cookie, csrf } = emitirSesion('Guillermo Rojas', 'vendedor', 'aaaaaaaa-0000-4000-8000-000000000001');
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
      const { cookie } = emitirSesion('Guillermo Rojas', 'vendedor', 'aaaaaaaa-0000-4000-8000-000000000001');
      const valor = cookie.split(';')[0];
      const res = await POST(peticion({}, { cookie: valor, 'sec-fetch-site': 'cross-site' }));
      expect(res.status).toBe(200);
      const cuerpo = await res.json();
      expect(cuerpo.ok).toBe(true);
      expect('csrf' in cuerpo).toBe(false);
    });

    it('con Sec-Fetch-Site: same-origin, sí devuelve el csrf (uso normal del panel)', async () => {
      const { cookie, csrf } = emitirSesion('Guillermo Rojas', 'vendedor', 'aaaaaaaa-0000-4000-8000-000000000001');
      const valor = cookie.split(';')[0];
      const res = await POST(peticion({}, { cookie: valor, 'sec-fetch-site': 'same-origin' }));
      const cuerpo = await res.json();
      expect(cuerpo.csrf).toBe(csrf);
    });
  });
});
