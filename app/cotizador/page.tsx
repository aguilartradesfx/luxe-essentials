import type { Metadata } from 'next';
import Cotizador from '@/app/cotizador/Cotizador';

// Ruta no enlazada desde ningún sitio, igual que /q7m4. La clave la pide el
// endpoint, no esta página: la protección real está en el servidor.
export const metadata: Metadata = {
  title: 'Cotizador',
  robots: { index: false, follow: false, nocache: true },
};

export default function Pagina() {
  return <Cotizador />;
}
