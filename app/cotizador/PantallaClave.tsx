'use client';

import { useState } from 'react';

// Pantalla de acceso, extraída de lo que antes vivía al principio de
// Cotizador.tsx (Tarea 9). No decide ella misma cómo se valida el correo ni
// la clave ni qué pasa al entrar — eso es responsabilidad de `Panel`, que le
// pasa `onEntrar`. Esta pieza solo sabe pedir el correo y la clave, mostrar
// el error que le devuelvan y reflejar el estado "entrando" mientras la
// promesa está en vuelo. Al estilo de app/q7m4/Taller.tsx.
//
// Tarea 3 (usuarios del panel): antes solo pedía la clave compartida. Ahora
// el panel identifica a la persona, así que hace falta también el correo —
// `onEntrar` manda los dos juntos a `/api/cotizacion/entrar`.
//
// Tarea 6 (pestaña de equipo): el primer campo se llamaba `usuario`, pero
// desde la Tarea 3 el valor que de verdad viaja acá es un correo (así lo
// identifica `/entrar` — ver lib/cotizador/usuarios.ts). Se renombra a
// `correo` para que el nombre no mienta, y la etiqueta, el marcador de
// posición y el `type` del campo pasan a reflejar eso. `autoComplete`
// se queda en `"username"`, no `"email"`: es el valor correcto para un
// correo que actúa como identidad de acceso — así lo entienden los
// gestores de contraseñas, más allá de la forma del texto.
type Props = {
  // Devuelve el mensaje de error a mostrar (el que manda el propio
  // servidor — "usuario o clave incorrectos", "cuenta bloqueada", etc.), o
  // `null` si la entrada fue correcta y ya se entró. `Panel` es quien
  // decide qué endpoint llamar y cómo interpretar la respuesta.
  onEntrar: (correo: string, clave: string) => Promise<string | null>;
  // Ronda de correcciones 2 (Tarea 9, hallazgo importante): explica POR QUÉ
  // se está pidiendo la clave, cuando no es la primera vez — típicamente
  // porque la sesión venció a mitad de una cotización (`Panel` se la manda
  // cuando `VistaCrear` reporta un 401). Sin esto, un formulario en blanco
  // después de perder minutos de trabajo era indistinguible de "nunca
  // entraste" — el vendedor no tenía forma de saber que lo armado seguía
  // ahí, detrás de este formulario. Distinto de `claveError`: este es
  // informativo (por qué se está viendo el formulario), no un error de la
  // credencial que se acaba de escribir.
  mensaje?: string;
};

export function PantallaClave({ onEntrar, mensaje }: Props) {
  const [correo, setCorreo] = useState('');
  const [clave, setClave] = useState('');
  const [claveError, setClaveError] = useState('');
  const [entrando, setEntrando] = useState(false);

  async function manejarEnvio(e: React.FormEvent) {
    e.preventDefault();
    setClaveError('');
    setEntrando(true);
    try {
      const error = await onEntrar(correo, clave);
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
        {mensaje && (
          <p className="mt-4 rounded-lg bg-[color:var(--carta-border)]/30 px-3 py-2 text-sm text-navy">
            {mensaje}
          </p>
        )}
        <label htmlFor="correo-cotizador" className="mt-6 block text-xs font-medium uppercase tracking-wide text-teal">
          Correo
        </label>
        <input
          id="correo-cotizador"
          type="email"
          autoComplete="username"
          value={correo}
          onChange={(e) => setCorreo(e.target.value)}
          placeholder="Correo"
          autoFocus
          className="mt-2 w-full rounded-lg border border-[var(--carta-border)] bg-white px-4 py-3 text-sm text-navy placeholder:text-teal/60"
        />
        <label htmlFor="clave-cotizador" className="mt-4 block text-xs font-medium uppercase tracking-wide text-teal">
          Clave
        </label>
        <input
          id="clave-cotizador"
          type="password"
          autoComplete="current-password"
          value={clave}
          onChange={(e) => setClave(e.target.value)}
          placeholder="Clave"
          className="mt-2 w-full rounded-lg border border-[var(--carta-border)] bg-white px-4 py-3 text-sm text-navy placeholder:text-teal/60"
        />
        {/* Ronda de correcciones 1 (Tarea 5, hallazgo menor): este mensaje es
            el que distingue "clave incorrecta" de "cuenta bloqueada, probá en
            15 minutos" — sin `role="alert"`, quien usa un lector de pantalla
            no se entera de cuál de las dos le tocó, porque el texto aparece
            después del envío, sin mover el foco. */}
        {claveError && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {claveError}
          </p>
        )}
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
