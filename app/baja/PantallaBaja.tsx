'use client';

import { useState } from 'react';

type Props = {
  // Vacío o inválido si la URL no traía `?t=` o si la firma no verificó
  // (enlace alterado a mano, o firmado con un `LUXE_BAJA_SECRETO` que ya no
  // es el vigente). Verificado por el componente de servidor (page.tsx),
  // sin tocar la base.
  token: string;
  correo: string | null;
  // Leído server-side en page.tsx y pasado como prop -- ver el comentario
  // ahí sobre por qué no se lee acá directamente. `undefined` si la
  // variable de entorno no está configurada: el mensaje se ajusta, nunca
  // inventa un correo (mismo criterio que `lineaContacto()` en
  // lib/cotizador/documento.tsx).
  contactoCorreo?: string;
};

// Error clásico de las páginas de baja: si el enlace ejecutara la baja con
// sólo cargarse, un antivirus o un escáner de correo que precarga enlaces
// (Outlook Safe Links, filtros corporativos, algunos antivirus) daría de
// baja a gente que nunca hizo clic con intención -- ABRIR el correo bastaría
// para desuscribirla. Por eso esta pantalla sólo MUESTRA la confirmación al
// cargar (GET, sin efectos) y la baja de verdad recién ocurre cuando la
// persona toca el botón, que dispara el POST a /api/baja/confirmar.
export function PantallaBaja({ token, correo, contactoCorreo }: Props) {
  const [estado, setEstado] = useState<'confirmando' | 'enviando' | 'lista' | 'error'>('confirmando');
  const [error, setError] = useState('');

  if (!correo) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-sm">
          <h1 className="font-display text-2xl text-navy">Luxe Essentials</h1>
          <p role="alert" className="mt-6 text-sm text-red-700">
            Este enlace no es válido o ya venció.
            {contactoCorreo
              ? ` Si querés dejar de recibir nuestros correos, escribinos a ${contactoCorreo}.`
              : ''}
          </p>
        </div>
      </main>
    );
  }

  async function confirmar() {
    setEstado('enviando');
    setError('');
    try {
      const res = await fetch('/api/baja/confirmar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const datos = await res.json().catch(() => null);
      if (!res.ok || !datos?.ok) {
        setError(datos?.error ?? `Error ${res.status}`);
        setEstado('error');
        return;
      }
      setEstado('lista');
    } catch {
      setError('No pudimos conectar con el servidor. Intentá de nuevo.');
      setEstado('error');
    }
  }

  if (estado === 'lista') {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-sm">
          <h1 className="font-display text-2xl text-navy">Luxe Essentials</h1>
          <p className="mt-6 text-sm text-teal">
            Listo: <strong>{correo}</strong> ya no va a recibir más correos nuestros.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="font-display text-2xl text-navy">Luxe Essentials</h1>
        <p className="mt-2 text-sm text-teal">Baja de correos</p>
        <p className="mt-6 text-sm text-navy">
          ¿Confirmás que no querés recibir más correos nuestros en <strong>{correo}</strong>?
        </p>
        {estado === 'error' && error && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={confirmar}
          disabled={estado === 'enviando'}
          className="mt-4 w-full rounded-lg bg-navy px-4 py-3 text-sm font-medium text-beige hover:bg-teal disabled:opacity-40"
        >
          {estado === 'enviando' ? 'Procesando…' : 'Sí, no quiero recibir más correos'}
        </button>
      </div>
    </main>
  );
}
