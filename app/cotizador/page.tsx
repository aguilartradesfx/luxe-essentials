import type { Metadata } from 'next';
import Panel from '@/app/cotizador/Panel';

// Ruta no enlazada desde ningún sitio, igual que /q7m4. La pantalla de
// acceso (dentro de Panel.tsx) no es la protección en sí —esa vive en los
// endpoints, que validan la sesión en tiempo constante—, pero ahora sí
// cumple un propósito real: sin usuario y clave válidos (ni sesión por
// cookie, Tarea 9) no se pide el catálogo, así que la lista de productos
// (sin precios) nunca baja al navegador. Ver Tarea 8.
export const metadata: Metadata = {
  title: 'Cotizador',
  robots: { index: false, follow: false, nocache: true },
};

export default function Pagina() {
  return <Panel />;
}
