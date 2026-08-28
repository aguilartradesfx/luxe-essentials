import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: { formats: ['image/avif', 'image/webp'] },
  // Tarea 6, ronda de correcciones 1: Next.js NO manda `X-Frame-Options` ni
  // ninguna `Content-Security-Policy` por defecto — el sitio entero ya era
  // embebible por cualquiera antes de este archivo, `/q7m4` (tras la misma
  // clave que el panel) incluido. Lo que hacen las cabeceras de abajo no es
  // "abrir" `/cotizador`, es CERRAR todo lo demás y abrir una excepción
  // puntual solo para GoHighLevel. Quien borre la regla de `/cotizador`
  // creyendo que solo desbloquea algo, en realidad no rompe nada del resto
  // del sitio — pero si borra la regla de acá abajo (la de `/:path*`),
  // vuelve a dejar todo el sitio embebible.
  //
  // Next.js aplica los `headers()` en el orden del arreglo: si dos reglas
  // matchean el mismo path y ponen la misma clave, la última gana (doc
  // oficial, sección "Header Overriding Behavior"). Por eso la regla general
  // va primero y la de `/cotizador` va después — así la sobrescribe ahí, sin
  // tocar el resto de rutas que sí matchean `/:path*` pero no `/cotizador`.
  async headers() {
    return [
      {
        // Por defecto, nada se embebe en ningún sitio. Clickjacking cerrado
        // en todo el sitio, no solo en el panel.
        source: '/:path*',
        headers: [{ key: 'Content-Security-Policy', value: "frame-ancestors 'none'" }],
      },
      {
        source: '/cotizador',
        headers: [
          {
            key: 'Content-Security-Policy',
            // Sólo GoHighLevel puede embeber el panel. Nunca '*': eso
            // dejaría que cualquier sitio lo embeba con la sesión del
            // vendedor dentro.
            //
            // `app.gohighlevel.com`/`*.gohighlevel.com` y
            // `*.leadconnectorhq.com` son los dominios estándar de
            // GoHighLevel/LeadConnector. `app.msgsndr.com`/`*.msgsndr.com`
            // es el otro dominio con el que LeadConnector sirve la app —
            // no se pudo verificar cuál usa este cliente en concreto. Si el
            // equipo entra por un dominio de marca blanca de una agencia
            // (subdominio propio de la agencia, no de GoHighLevel), ese
            // dominio hay que agregarlo acá o el panel se ve en blanco
            // dentro del menu link.
            value:
              "frame-ancestors 'self' https://app.gohighlevel.com https://*.gohighlevel.com https://*.leadconnectorhq.com https://app.msgsndr.com https://*.msgsndr.com",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
