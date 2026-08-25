import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/app/metadata';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Los endpoints del formulario y del webhook de GHL no son contenido:
      // sólo aceptan POST y no tienen nada que indexar.
      // El banco de pruebas es una herramienta interna, no contenido.
      disallow: ['/api/', '/q7m4'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
