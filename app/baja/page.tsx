import type { Metadata } from 'next';
import { correoDeToken } from '@/lib/campanas/baja';
import { PantallaBaja } from './PantallaBaja';

// La página del pie de las cuatro plantillas de campaña
// (`{{unsubscribe_url}}`, ver lib/campanas/baja.ts). Pública, sin sesión: a
// esta ruta llega alguien que abrió un correo, no alguien que entró al
// panel.
export const metadata: Metadata = {
  title: 'Baja de correos',
  robots: { index: false, follow: false, nocache: true },
};

type Props = {
  searchParams: Promise<{ t?: string | string[] }>;
};

export default async function Pagina({ searchParams }: Props) {
  const parametros = await searchParams;
  const token = typeof parametros.t === 'string' ? parametros.t : '';

  // La firma se verifica ACÁ, en el servidor, y sin tocar la base -- es
  // exactamente lo que "autoverificable" (Tarea 1) permite: mostrar con qué
  // correo se está a punto de dar de baja a alguien sin haber hecho ninguna
  // consulta todavía. La baja de verdad -- la escritura -- sólo ocurre si la
  // persona toca el botón (ver PantallaBaja.tsx, y el porqué en su propio
  // comentario).
  const correo = token ? correoDeToken(token) : null;

  // Leído acá y pasado como prop, no dentro de PantallaBaja (componente de
  // cliente): `LUXE_CONTACTO_CORREO` no lleva el prefijo `NEXT_PUBLIC_`, así
  // que en el navegador `process.env.LUXE_CONTACTO_CORREO` sería siempre
  // `undefined` -- mismo motivo por el que `lineaContacto()` en
  // `lib/cotizador/documento.tsx` sólo se llama desde código de servidor.
  const contactoCorreo = process.env.LUXE_CONTACTO_CORREO || undefined;

  return <PantallaBaja token={token} correo={correo} contactoCorreo={contactoCorreo} />;
}
