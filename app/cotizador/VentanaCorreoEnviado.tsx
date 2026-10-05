'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ETIQUETAS_PLANTILLA, formatearFecha } from './formato';
import { prepararVistaPrevia } from '@/lib/campanas/vista-previa-correo';

// La ventana que se abre al hacer clic en una fila de «Correos enviados»:
// el correo tal cual le llegó a esa persona (asunto y cuerpo, con su empresa
// y todo lo demás ya resuelto). Lo arma el servidor con las mismas funciones
// que lo armaron al enviarlo (lib/campanas/envio-correo.ts); acá sólo se
// muestra. El cuerpo se pide recién al abrir (POST /api/campanas/envios/correo):
// el listado no lo trae.
//
// Es HTML ajeno -- y en la plantilla personalizada, lo que alguien haya
// pegado -- así que NO se mete en el panel: va dentro de un marco con
// `sandbox=""` (ningún permiso: ni scripts, ni navegar, ni abrir ventanas, ni
// formularios, y origen aislado), y antes se le quita todo destino a los
// enlaces (lib/campanas/vista-previa-correo.ts): el enlace de baja que trae
// es REAL, y un clic daría de baja a un cliente de verdad.

export type FilaCorreo = {
  id: string;
  correo: string;
  empresa: string;
  zona: string | null;
  plantilla: string;
  enviadoAt: string;
};

// Lo que devuelve la ruta (lib/campanas/envio-correo.ts, `CorreoEnviado`).
type Correo = {
  id: string;
  destinatario: string;
  empresa: string;
  zona: string | null;
  plantilla: string;
  campanaId: string;
  enviadoAt: string;
  salio: boolean;
  asunto: string;
  html: string;
};
type Props = { fila: FilaCorreo; onCerrar: () => void; onSesionInvalida: () => void };

const SELECTOR_ENFOCABLES = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function VentanaCorreoEnviado({ fila, onCerrar, onSesionInvalida }: Props) {
  const idTitulo = useId();
  const ventana = useRef<HTMLDivElement>(null);
  const botonCerrar = useRef<HTMLButtonElement>(null);
  const marco = useRef<HTMLIFrameElement>(null);
  const [correo, setCorreo] = useState<Correo | null>(null);
  const [error, setError] = useState('');
  const [intento, setIntento] = useState(0);

  // Pide el cuerpo. Si se cierra (o se reintenta) con una respuesta en
  // camino, se descarta: no puede pintar nada en una ventana que ya no está.
  useEffect(() => {
    const control = new AbortController();
    setCorreo(null);
    setError('');
    (async () => {
      try {
        const res = await fetch('/api/campanas/envios/correo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: fila.id }),
          signal: control.signal,
        });
        const datos = await res.json();
        if (control.signal.aborted) return;
        if (!res.ok || !datos.ok) {
          if (res.status === 401) return onSesionInvalida();
          setError(datos.error ?? `Error ${res.status}`);
          return;
        }
        setCorreo(datos.correo as Correo);
      } catch {
        if (!control.signal.aborted) setError('Fallo de red al consultar el correo.');
      }
    })();
    return () => control.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onSesionInvalida` es estable entre renders (viene de Panel).
  }, [fila.id, intento]);

  // Foco: al abrir pasa a la ventana, queda atrapado adentro, y al cerrar
  // vuelve a donde estaba (la fila que se tocó). Mientras está abierta, la
  // página de atrás no se desplaza.
  useEffect(() => {
    const anterior = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    botonCerrar.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      anterior?.focus?.();
    };
  }, []);

  // El correo vive en un marco aislado, y un clic adentro le llevaría el
  // foco: allí Escape ya no llegaría a esta página. Se lo devolvemos a la
  // ventana apenas lo toma (el correo se sigue pudiendo desplazar con el
  // mouse o el dedo).
  useEffect(() => {
    function alPerderFoco() {
      setTimeout(() => {
        if (marco.current && document.activeElement === marco.current) botonCerrar.current?.focus();
      }, 0);
    }
    window.addEventListener('blur', alPerderFoco);
    return () => window.removeEventListener('blur', alPerderFoco);
  }, []);

  const alTeclear = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'Tab' || !ventana.current) return;
      const enfocables = Array.from(ventana.current.querySelectorAll<HTMLElement>(SELECTOR_ENFOCABLES)).filter(
        (el) => !el.hasAttribute('disabled'),
      );
      if (enfocables.length === 0) return;
      const primero = enfocables[0];
      const ultimo = enfocables[enfocables.length - 1];
      if (e.shiftKey && document.activeElement === primero) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault();
        primero.focus();
      }
    },
    [],
  );

  // Escape cierra, esté el foco donde esté: se escucha en el documento
  // mientras la ventana esté abierta.
  useEffect(() => {
    function alTeclearEnDocumento(e: KeyboardEvent) {
      if (e.key === 'Escape') onCerrar();
    }
    document.addEventListener('keydown', alTeclearEnDocumento);
    return () => document.removeEventListener('keydown', alTeclearEnDocumento);
  }, [onCerrar]);

  const documento = useMemo(() => (correo ? prepararVistaPrevia(correo.html) : ''), [correo]);
  // Mientras llega el correo ya se sabe a quién, de dónde y cuándo: viene de la fila.
  const datos = correo
    ? { ...correo, correo: correo.destinatario }
    : { correo: fila.correo, empresa: fila.empresa, zona: fila.zona, plantilla: fila.plantilla, enviadoAt: fila.enviadoAt };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-6"
      onMouseDown={(e) => {
        // Sólo un clic que EMPIEZA fuera de la ventana la cierra: arrastrar
        // para seleccionar texto y soltar afuera no debe cerrarla.
        if (e.target === e.currentTarget) onCerrar();
      }}
    >
      <div
        ref={ventana}
        role="dialog"
        aria-modal="true"
        aria-labelledby={idTitulo}
        aria-busy={!correo && !error}
        tabIndex={-1}
        onKeyDown={alTeclear}
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--carta-border)] bg-white shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--carta-border)] px-4 py-3">
          <div className="min-w-0">
            <h3 id={idTitulo} className="font-display text-sm text-navy">
              Correo enviado a {datos.empresa}
            </h3>
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-teal">
              <dt>Para</dt>
              <dd className="break-all text-navy">{datos.correo}</dd>
              <dt>Empresa</dt>
              <dd className="text-navy">{datos.empresa}</dd>
              <dt>Zona</dt>
              <dd className="text-navy">{datos.zona ?? '—'}</dd>
              <dt>Campaña</dt>
              <dd className="text-navy">{ETIQUETAS_PLANTILLA[datos.plantilla] ?? datos.plantilla}</dd>
              <dt>Salió</dt>
              <dd className="text-navy">{formatearFecha(datos.enviadoAt)}</dd>
            </dl>
          </div>
          <button
            ref={botonCerrar}
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar"
            className="shrink-0 rounded-lg border border-[var(--carta-border)] px-3 py-1.5 text-xs font-medium text-navy hover:bg-[var(--carta-fill)]"
          >
            Cerrar
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {!correo && !error && (
            <div role="status" aria-live="polite" className="space-y-2">
              <p className="text-xs text-teal">Cargando el correo…</p>
              <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--carta-fill)]" />
              <div className="h-64 animate-pulse rounded-lg bg-[var(--carta-fill)]" />
            </div>
          )}

          {error && (
            <div role="alert" className="space-y-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
              <p>{error}</p>
              <button
                type="button"
                onClick={() => setIntento((n) => n + 1)}
                className="rounded-lg border border-red-300 px-3 py-1 font-medium hover:bg-red-100"
              >
                Reintentar
              </button>
            </div>
          )}

          {correo && (
            <>
              {!correo.salio && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Este correo nunca llegó a salir. Así se habría visto.
                </p>
              )}
              <p className="text-sm text-navy">
                <span className="text-xs text-teal">Asunto: </span>
                <span className="font-medium">{correo.asunto}</span>
              </p>
              <iframe
                ref={marco}
                title={`Correo enviado a ${correo.destinatario}`}
                sandbox=""
                referrerPolicy="no-referrer"
                tabIndex={-1}
                srcDoc={documento}
                className="h-[55vh] w-full rounded-lg border border-[var(--carta-border)] bg-white"
              />
              <p className="text-xs text-teal/70">
                Es una vista del correo: los enlaces no se pueden abrir desde acá.
              </p>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
