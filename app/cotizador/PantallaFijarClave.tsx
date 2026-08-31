'use client';

import { useState } from 'react';

// Pantalla para que una persona invitada elija su propia clave. Mismo estilo
// visual que PantallaClave.tsx (que pide usuario y clave a alguien que ya
// tiene cuenta) — esta pide la clave dos veces, sin usuario, porque el
// enlace en sí ya identifica a la cuenta.
type Props = {
  // Viene de `searchParams.enlace`, leído por el componente de servidor
  // (page.tsx). Vacío si la URL no lo trae — ver el caso "enlace incompleto"
  // más abajo.
  enlace: string;
};

const MENSAJE_NO_COINCIDEN = 'Las dos claves no coinciden.';

export function PantallaFijarClave({ enlace }: Props) {
  const [clave, setClave] = useState('');
  const [repetirClave, setRepetirClave] = useState('');
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);

  // Sin enlace en la URL no hay nada que fijar: se dice que está incompleto
  // y no se muestra el formulario, en vez de dejar que la persona escriba
  // una clave que después el servidor va a rechazar igual.
  if (!enlace) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-xs">
          <h1 className="font-display text-2xl text-navy">Cotizador</h1>
          <p className="mt-2 text-sm text-teal">Luxe Essentials</p>
          <p role="alert" className="mt-6 text-sm text-red-700">
            Este enlace está incompleto. Pedile a quien te invitó que te mande uno nuevo.
          </p>
        </div>
      </main>
    );
  }

  async function manejarEnvio(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    // Se comprueba que coincidan antes de llamar al servidor: no tiene
    // sentido gastar una derivación de scrypt para descartarla en el acto.
    if (clave !== repetirClave) {
      setError(MENSAJE_NO_COINCIDEN);
      return;
    }

    setEnviando(true);
    try {
      const res = await fetch('/api/cotizacion/fijar-clave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enlace, clave }),
      });
      const datos = await res.json().catch(() => null);
      if (!res.ok || !datos?.ok) {
        setError(datos?.error ?? `Error ${res.status}`);
        setEnviando(false);
        return;
      }
      // Sesión ya abierta (la cookie llegó en la respuesta): navegación
      // completa, no un `router.push`, para que el panel arranque con la
      // cookie recién puesta.
      window.location.href = '/cotizador';
    } catch {
      setError('No pudimos conectar con el servidor. Intentá de nuevo.');
      setEnviando(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <form onSubmit={manejarEnvio} className="w-full max-w-xs">
        <h1 className="font-display text-2xl text-navy">Cotizador</h1>
        <p className="mt-2 text-sm text-teal">Elegí tu clave para entrar</p>
        <label
          htmlFor="clave-nueva"
          className="mt-6 block text-xs font-medium uppercase tracking-wide text-teal"
        >
          Clave
        </label>
        <input
          id="clave-nueva"
          type="password"
          autoComplete="new-password"
          value={clave}
          onChange={(e) => setClave(e.target.value)}
          placeholder="Al menos 10 caracteres"
          autoFocus
          className="mt-2 w-full rounded-lg border border-[var(--carta-border)] bg-white px-4 py-3 text-sm text-navy placeholder:text-teal/60"
        />
        <label
          htmlFor="clave-repetir"
          className="mt-4 block text-xs font-medium uppercase tracking-wide text-teal"
        >
          Repetir clave
        </label>
        <input
          id="clave-repetir"
          type="password"
          autoComplete="new-password"
          value={repetirClave}
          onChange={(e) => setRepetirClave(e.target.value)}
          placeholder="Repetí la clave"
          className="mt-2 w-full rounded-lg border border-[var(--carta-border)] bg-white px-4 py-3 text-sm text-navy placeholder:text-teal/60"
        />
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={enviando}
          className="mt-3 w-full rounded-lg bg-navy px-4 py-3 text-sm font-medium text-beige hover:bg-teal disabled:opacity-40"
        >
          {enviando ? 'Guardando…' : 'Elegir clave'}
        </button>
      </form>
    </main>
  );
}
