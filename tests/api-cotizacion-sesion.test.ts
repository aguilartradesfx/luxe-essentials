import { describe, it, expect, vi, beforeEach } from 'vitest';

// Ronda de correcciones 1 (Tarea 6): las siete pruebas de panel-sesion.test.ts
// son unitarias sobre lib/sesion.ts — no ejercitan ni una sola ruta real. El
// revisor probó tres mutantes sobre el código de las rutas y las 529 pruebas
// de entonces seguían en verde:
//   1. Quitar el bloque anti-CSRF entero de app/api/cotizacion/route.ts.
//   2. Poner `frame-ancestors *` en next.config.ts (cubierto aparte en
//      tests/next-config-cabeceras.test.ts).
//   3. Que las rutas de lectura dejen de aceptar la cookie.
// Y por construcción, quitar la validación de clave de /entrar tampoco
// rompía nada, porque esa ruta no tenía archivo de pruebas. Este archivo
// cierra las cuatro grietas.

// Tarea 12: `notaDeCotizacion` queda real vía `importOriginal` (es pura y
// local); sólo se mockea `crearEstimate`. `agregarNota` se mockea aparte
// (ver abajo) para que ninguna prueba de este archivo dispare una llamada
// de red real cuando el correo "sale".
vi.mock('@/lib/cotizador/ghl', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cotizador/ghl')>();
  return {
    ...real,
    crearEstimate: vi.fn().mockResolvedValue({ ok: true, estimateId: 'est-1', contactId: 'contacto-ghl-1' }),
  };
});
vi.mock('@/lib/agente/acciones', () => ({
  agregarNota: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/cotizador/documento', () => ({
  renderizarCotizacion: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7 falso')),
}));
vi.mock('@/lib/cotizador/almacen', () => ({
  guardarPdf: vi.fn().mockResolvedValue({ ok: true, ruta: '2026/COT-1-abc.pdf' }),
  enlaceFirmado: vi.fn().mockResolvedValue({ ok: true, url: 'https://firmada' }),
}));
vi.mock('@/lib/cotizador/correo', () => ({
  enviarCotizacion: vi.fn().mockResolvedValue({ ok: true, resendId: 're_1' }),
}));
vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => ({ data: { id: 'cot-1', numero: 'COT-2026-0001' }, error: null }),
        }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

const { POST: postCotizacion } = await import('@/app/api/cotizacion/route');
const { POST: postCatalogo } = await import('@/app/api/cotizacion/catalogo/route');
const { POST: postPrevisualizar } = await import('@/app/api/cotizacion/previsualizar/route');
const { POST: postBorradores } = await import('@/app/api/cotizacion/borradores/route');
const { POST: postEntrar } = await import('@/app/api/cotizacion/entrar/route');
const { emitirSesion } = await import('@/lib/sesion');

function peticion(url: string, cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabeceras },
    body: JSON.stringify(cuerpo),
  });
}

const cotizacionValida = {
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
  lineas: [{ skuId: 'set-600-king', cantidad: 16 }],
};

const previsualizarValida = { lineas: [{ skuId: 'set-600-king', cantidad: 16 }] };

describe('rutas de app/api/cotizacion/* — sesión por cookie y CSRF', () => {
  beforeEach(() => {
    process.env.LUXE_TALLER_CLAVE = 'secreta';
  });

  describe('POST /api/cotizacion (escribe): exige CSRF cuando entra por cookie', () => {
    it('mata el mutante 1: cookie válida SIN el token anti-CSRF en la cabecera → 401', async () => {
      const { cookie } = emitirSesion();
      const valor = cookie.split(';')[0];
      const res = await postCotizacion(
        peticion('http://localhost/api/cotizacion', cotizacionValida, { cookie: valor }),
      );
      expect(res.status).toBe(401);
    });

    it('cookie válida con un token anti-CSRF que no coincide → 401', async () => {
      const { cookie } = emitirSesion();
      const valor = cookie.split(';')[0];
      const res = await postCotizacion(
        peticion('http://localhost/api/cotizacion', cotizacionValida, {
          cookie: valor,
          'x-csrf-token': 'inventado',
        }),
      );
      expect(res.status).toBe(401);
    });

    it('cookie válida CON el token anti-CSRF correcto → pasa (200)', async () => {
      const { cookie, csrf } = emitirSesion();
      const valor = cookie.split(';')[0];
      const res = await postCotizacion(
        peticion('http://localhost/api/cotizacion', cotizacionValida, {
          cookie: valor,
          'x-csrf-token': csrf,
        }),
      );
      expect(res.status).toBe(200);
    });

    it('clave en el cuerpo SIN cookie ni CSRF sigue pasando: la clave no lo exige', async () => {
      const res = await postCotizacion(
        peticion('http://localhost/api/cotizacion', { ...cotizacionValida, clave: 'secreta' }),
      );
      expect(res.status).toBe(200);
    });

    it('sin clave y sin cookie → 401', async () => {
      const res = await postCotizacion(peticion('http://localhost/api/cotizacion', cotizacionValida));
      expect(res.status).toBe(401);
    });
  });

  describe('rutas de solo lectura: aceptan la cookie sin exigir CSRF', () => {
    it('mata el mutante 3: /catalogo con cookie válida y sin clave en el cuerpo → pasa (200)', async () => {
      const { cookie } = emitirSesion();
      const valor = cookie.split(';')[0];
      const res = await postCatalogo(peticion('http://localhost/api/cotizacion/catalogo', {}, { cookie: valor }));
      expect(res.status).toBe(200);
    });

    it('/previsualizar con cookie válida y sin clave en el cuerpo → pasa (200)', async () => {
      const { cookie } = emitirSesion();
      const valor = cookie.split(';')[0];
      const res = await postPrevisualizar(
        peticion('http://localhost/api/cotizacion/previsualizar', previsualizarValida, { cookie: valor }),
      );
      expect(res.status).toBe(200);
    });

    it('/borradores con cookie válida y sin clave en el cuerpo → pasa (200)', async () => {
      const { cookie } = emitirSesion();
      const valor = cookie.split(';')[0];
      const res = await postBorradores(
        peticion('http://localhost/api/cotizacion/borradores', {}, { cookie: valor }),
      );
      expect(res.status).toBe(200);
    });

    it('/catalogo sin clave y sin cookie → 401', async () => {
      const res = await postCatalogo(peticion('http://localhost/api/cotizacion/catalogo', {}));
      expect(res.status).toBe(401);
    });

    it('/previsualizar con una cookie inventada (no una sesión real) → 401', async () => {
      const res = await postPrevisualizar(
        peticion('http://localhost/api/cotizacion/previsualizar', previsualizarValida, {
          cookie: 'luxe_sesion=inventado',
        }),
      );
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/cotizacion/entrar', () => {
    it('con clave incorrecta → 401 y sin cabecera Set-Cookie', async () => {
      const res = await postEntrar(peticion('http://localhost/api/cotizacion/entrar', { clave: 'otra' }));
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('con clave correcta → 200, con csrf en el cuerpo y Set-Cookie con SameSite=None', async () => {
      const res = await postEntrar(peticion('http://localhost/api/cotizacion/entrar', { clave: 'secreta' }));
      expect(res.status).toBe(200);
      const cuerpo = await res.json();
      expect(cuerpo.ok).toBe(true);
      expect(typeof cuerpo.csrf).toBe('string');
      expect(cuerpo.csrf.length).toBeGreaterThan(0);
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain('luxe_sesion=');
      expect(setCookie).toMatch(/SameSite=None/i);
    });

    it('registra en consola un intento con clave incorrecta (hace visible un ataque de fuerza bruta)', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      await postEntrar(peticion('http://localhost/api/cotizacion/entrar', { clave: 'otra' }));
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });
});
