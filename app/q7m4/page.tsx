import type { Metadata } from 'next';
import { Taller } from './Taller';

export const metadata: Metadata = {
  title: 'Banco de pruebas',
  // Fuera de buscadores: es una herramienta interna, no contenido del sitio.
  robots: { index: false, follow: false, nocache: true },
};

export default function Pagina() {
  return <Taller />;
}
