'use client';

import { useState } from 'react';

// Pantalla de clave, extraída de lo que antes vivía al principio de
// Cotizador.tsx (Tarea 9). No decide ella misma cómo se valida la clave ni
// qué pasa al entrar — eso es responsabilidad de `Panel`, que le pasa
// `onEntrar`. Esta pieza solo sabe pedir la clave, mostrar el error que le
// devuelvan y reflejar el estado "entrando" mientras la promesa está en
// vuelo. Al estilo de app/q7m4/Taller.tsx.
type Props = {
  // Devuelve el mensaje de error a mostrar, o `null` si la clave era
  // correcta y ya se entró. `Panel` es quien decide qué endpoint llamar.
  onEntrar: (clave: string) => Promise<string | null>;
};

export function PantallaClave({ onEntrar }: Props) {
  const [clave, setClave] = useState('');
  const [claveError, setClaveError] = useState('');
  const [entrando, setEntrando] = useState(false);

  async function manejarEnvio(e: React.FormEvent) {
    e.preventDefault();
    setClaveError('');
    setEntrando(true);
    try {
      const error = await onEntrar(clave);
      if (error) setClaveError(error);
    } finally {
      setEntrando(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <form onSubmit={manejarEnvio} className="w-full max-w-xs">
        <h1 className="font-display text-2xl text-navy">Cotizador</h1>
        <p className="mt-2 text-sm text-teal">Luxe Essentials</p>
        <input
          type="password"
          aria-label="Clave"
          value={clave}
          onChange={(e) => setClave(e.target.value)}
          placeholder="Clave"
          autoFocus
          className="mt-6 w-full rounded-lg border border-[var(--carta-border)] bg-white px-4 py-3 text-sm text-navy placeholder:text-teal/60"
        />
        {claveError && <p className="mt-2 text-sm text-red-700">{claveError}</p>}
        <button
          type="submit"
          disabled={entrando}
          className="mt-3 w-full rounded-lg bg-navy px-4 py-3 text-sm font-medium text-beige hover:bg-teal disabled:opacity-40"
        >
          {entrando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}
