import { describe, it, expect } from 'vitest';
import nextConfig from '@/next.config';

// Ronda de correcciones 1 (Tarea 6): el revisor probó cambiar la cabecera de
// `/cotizador` a `frame-ancestors *` y las 529 pruebas seguían en verde,
// porque nada verificaba el contenido de next.config.ts. Estas pruebas
// llaman a `headers()` de verdad (la misma función que usa Next.js al
// arrancar) y miran el valor exacto.

async function cabecerasPara(path: string): Promise<Record<string, string>> {
  const reglas = await nextConfig.headers!();
  const resultado: Record<string, string> = {};
  for (const regla of reglas) {
    // Mismo criterio de matching que usa Next.js para estas dos rutas
    // concretas: `/:path*` matchea cualquier path, `/cotizador` solo el
    // exacto. No hace falta un matcher genérico de path-to-regexp para las
    // dos reglas que este archivo define hoy.
    const matchea = regla.source === '/:path*' || regla.source === path;
    if (!matchea) continue;
    for (const cabecera of regla.headers ?? []) {
      // Simula "el último que matchea gana", igual que Next.js: ver la
      // sección "Header Overriding Behavior" de la documentación oficial.
      resultado[cabecera.key] = cabecera.value;
    }
  }
  return resultado;
}

// Valor exacto esperado de `frame-ancestors` en `/cotizador`. Se compara
// con `toBe` más abajo (no solo con `toContain` por pedazos) a propósito:
// un mutante que borre CUALQUIERA de los dominios (GoHighLevel o la marca
// blanca del dueño, `app.bralto.io`) tiene que poner la prueba en rojo, no
// solo el que borre "gohighlevel.com" a secas. `toContain` por dominio
// suelto no alcanza para eso -- ver el hallazgo del revisor en el
// comentario de arriba: 529 pruebas en verde con `frame-ancestors *`
// significa que hace falta mirar el valor completo, no un fragmento.
const CSP_COTIZADOR_ESPERADA =
  "frame-ancestors 'self' https://app.gohighlevel.com https://*.gohighlevel.com https://*.leadconnectorhq.com https://app.msgsndr.com https://*.msgsndr.com https://app.bralto.io";

describe('next.config.ts — cabeceras de /cotizador', () => {
  it('/cotizador permite el iframe solo de dominios de GoHighLevel y de la marca blanca del dueño, nunca "*"', async () => {
    const cabeceras = await cabecerasPara('/cotizador');
    const csp = cabeceras['Content-Security-Policy'];
    expect(csp).toBeTruthy();
    expect(csp).toContain('frame-ancestors');
    // Valor exacto: mata cualquier mutante que agregue, quite o cambie un
    // dominio de la lista (incluido borrar `app.bralto.io`, la marca
    // blanca del dueño).
    expect(csp).toBe(CSP_COTIZADOR_ESPERADA);
    // El mutante que el revisor probó: cambiar la lista de dominios por un
    // comodín abierto a cualquier sitio. Ojo: `csp` sí contiene asteriscos
    // legítimos (`https://*.gohighlevel.com`), por eso la aserción es sobre
    // el propio valor de `frame-ancestors`, no sobre la presencia de "*".
    // Redundante con el `toBe` de arriba, pero se deja explícito: es
    // justo el mutante que ya se probó una vez.
    expect(csp).not.toMatch(/frame-ancestors\s+\*(\s|$)/);
    expect(csp).not.toContain("frame-ancestors '*'");
  });

  // El hallazgo de esta ronda: `app.bralto.io` (la marca blanca del dueño)
  // no estaba en la lista, así que el navegador se negaba a pintar el
  // panel embebido ahí -- pantalla en blanco, sin aviso posible desde
  // dentro del iframe bloqueado. Prueba aparte (además del `toBe` de
  // arriba) para que el fallo, si vuelve, diga con nombre propio qué
  // dominio falta.
  it('/cotizador incluye la marca blanca del dueño, app.bralto.io', async () => {
    const cabeceras = await cabecerasPara('/cotizador');
    expect(cabeceras['Content-Security-Policy']).toContain('https://app.bralto.io');
  });

  // Conservar lo que ya sirve: quitar cualquiera de los dominios de
  // GoHighLevel de la lista (por accidente, al tocar `app.bralto.io`) deja
  // sin acceso a un cliente que sí funciona hoy. Una prueba por dominio
  // para que el mensaje de fallo señale exactamente cuál se perdió.
  it.each([
    'https://app.gohighlevel.com',
    'https://*.gohighlevel.com',
    'https://*.leadconnectorhq.com',
    'https://app.msgsndr.com',
    'https://*.msgsndr.com',
  ])('/cotizador conserva el dominio de GoHighLevel %s', async (dominio) => {
    const cabeceras = await cabecerasPara('/cotizador');
    expect(cabeceras['Content-Security-Policy']).toContain(dominio);
  });

  it('cualquier otra ruta del sitio no se puede embeber en absoluto (frame-ancestors none)', async () => {
    // El resto del sitio, `/q7m4` incluido, no tiene por qué ser embebible
    // por nadie: solo el panel necesita la excepción.
    for (const ruta of ['/', '/q7m4', '/api/cotizacion']) {
      const cabeceras = await cabecerasPara(ruta);
      expect(cabeceras['Content-Security-Policy']).toBe("frame-ancestors 'none'");
    }
  });

  it('la regla general no sobrevive en /cotizador: la específica la reemplaza, no se suman', async () => {
    // Si alguien reordena el arreglo y pone `/cotizador` antes que
    // `/:path*`, Next.js aplicaría la regla general al final y volvería a
    // cerrar el panel — esta prueba fija el orden correcto.
    const cabeceras = await cabecerasPara('/cotizador');
    expect(cabeceras['Content-Security-Policy']).not.toBe("frame-ancestors 'none'");
  });
});
