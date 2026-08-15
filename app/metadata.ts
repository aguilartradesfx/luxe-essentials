import type { Metadata } from 'next';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

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
  robots: { index: true, follow: true },
};
