import type { Metadata } from 'next';

// Se exporta porque sitemap.ts y robots.ts necesitan exactamente la misma
// URL: si divergen, el sitemap declara un dominio y las etiquetas OG otro.
//
// El orden del fallback importa. Antes se caía directo a localhost, y eso en
// producción no rompe nada de forma visible: el sitio se ve bien, pero las
// etiquetas Open Graph apuntan a localhost y la previsualización al compartir
// el enlace en WhatsApp o Facebook sale rota. Vercel expone
// VERCEL_PROJECT_PRODUCTION_URL en todo despliegue, así que un olvido de
// configuración degrada al dominio de Vercel en vez de a una URL inservible.
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : 'http://localhost:3000');

export const siteMetadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Uniformes y textiles para empresas en Costa Rica | Luxe Essentials',
    template: '%s · Luxe Essentials',
  },
  description:
    'Uniformes profesionales y textiles institucionales fabricados a pedido para hotelería, salud, industria, educación y retail. Entrega en 30 días en Costa Rica, desde 24 piezas.',
  openGraph: {
    type: 'website',
    locale: 'es_CR',
    url: SITE_URL,
    siteName: 'Luxe Essentials',
    title: 'Uniformes y textiles para empresas en Costa Rica | Luxe Essentials',
    description:
      'Uniformes profesionales y textiles institucionales fabricados a pedido, desde 24 piezas y con entrega en unos 30 días.',
  },
  alternates: { canonical: '/' },
  robots: { index: true, follow: true },
};
