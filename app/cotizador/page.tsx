import type { Metadata } from 'next';
import Cotizador from '@/app/cotizador/Cotizador';

// Ruta no enlazada desde ningún sitio, igual que /q7m4. La pantalla de clave
// (dentro de Cotizador.tsx) no es la protección en sí —esa vive en los
// endpoints, que la validan en tiempo constante—, pero ahora sí cumple un
// propósito real: sin clave válida no se pide el catálogo, así que la lista
// de productos (sin precios) nunca baja al navegador. Ver Tarea 8.
export const metadata: Metadata = {
  title: 'Cotizador',
  robots: { index: false, follow: false, nocache: true },
};

export default function Pagina() {
  return <Cotizador />;
}
