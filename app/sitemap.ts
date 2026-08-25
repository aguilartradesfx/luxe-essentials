import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/app/metadata';

// El sitio es una sola landing: una entrada, no un recorrido de rutas. Vale
// la pena igual, porque le da a Google una fecha de última modificación y una
// URL canónica con dominio, en vez de dejar que la infiera del enlace que
// encuentre primero.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 1,
    },
  ];
}
