import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: { formats: ['image/avif', 'image/webp'] },
  // Tarea 6: GoHighLevel abre el menu link del panel en un iframe. La
  // configuración por defecto de Next.js bloquea que cualquiera lo embeba;
  // sin esta cabecera el menu link muestra un marco en blanco.
  async headers() {
    return [
      {
        source: '/cotizador',
        headers: [
          {
            key: 'Content-Security-Policy',
            // Sólo GoHighLevel puede embeber el panel. Nunca '*': eso
            // dejaría que cualquier sitio lo embeba con la sesión del
            // vendedor dentro.
            value:
              "frame-ancestors 'self' https://app.gohighlevel.com https://*.gohighlevel.com https://*.leadconnectorhq.com",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
