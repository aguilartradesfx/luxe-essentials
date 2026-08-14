import type { Metadata } from 'next';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

export const siteMetadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Luxe Essentials — Manufactura textil en Guatemala',
    template: '%s · Luxe Essentials',
  },
  description:
    'Planta propia en Guatemala: uniformes industriales y corporativos, y textiles de hogar. Diseño, corte, bordado y empaque bajo un mismo techo.',
  openGraph: {
    type: 'website',
    locale: 'es_GT',
    url: SITE_URL,
    siteName: 'Luxe Essentials',
    title: 'Luxe Essentials — Manufactura textil en Guatemala',
    description:
      'Uniformes industriales y corporativos, y textiles de hogar, fabricados en planta propia.',
  },
  robots: { index: true, follow: true },
};
