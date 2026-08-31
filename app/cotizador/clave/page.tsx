import type { Metadata } from 'next';
import { PantallaFijarClave } from '@/app/cotizador/PantallaFijarClave';

// Ruta a la que apunta el botón del correo de invitación
// (lib/cotizador/correo-invitacion.ts). No enlazada desde ningún otro lado
// del sitio, igual que /cotizador y /q7m4.
export const metadata: Metadata = {
  title: 'Elegí tu clave',
  robots: { index: false, follow: false, nocache: true },
};

type Props = {
  searchParams: Promise<{ enlace?: string | string[] }>;
};

export default async function Pagina({ searchParams }: Props) {
  const parametros = await searchParams;
  const enlace = typeof parametros.enlace === 'string' ? parametros.enlace : '';
  return <PantallaFijarClave enlace={enlace} />;
}
