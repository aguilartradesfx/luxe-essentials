import type { Metadata } from 'next';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

export const siteMetadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Luxe Essentials — Uniformes y textiles para hotelería en Costa Rica',
    template: '%s · Luxe Essentials',
  },
  description:
    'Uniformes profesionales y textiles institucionales fabricados a pedido para hoteles, restaurantes, salud e industria. Entrega en unos 30 días en Costa Rica.',
  openGraph: {
    type: 'website',
    locale: 'es_CR',
    url: SITE_URL,
    siteName: 'Luxe Essentials',
    title: 'Luxe Essentials — Uniformes y textiles para hotelería en Costa Rica',
    description:
      'Uniformes profesionales y textiles institucionales fabricados a pedido, con entrega en unos 30 días.',
  },
  robots: { index: true, follow: true },
};
