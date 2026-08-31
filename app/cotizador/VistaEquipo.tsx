'use client';

import { useEffect, useState } from 'react';

// Tarea 6: la pestaña "Equipo". Sólo la ve un superadmin de VERDAD —"de
// verdad" porque, aunque `Panel` sólo dibuja el botón que lleva acá cuando
// `rol === 'superadmin'` (ver el comentario junto a esa pestaña en
// Panel.tsx), esa condición es cosmética: las cuatro rutas de
// app/api/equipo/* (listar, invitar, reenviar, estado) releen la fila de
// quien hace la petición en la base antes de actuar
// (`autorizarSuperadmin`, lib/cotizador/equipo.ts) y devuelven 403 si no es
// superadmin ahora mismo. Este componente no agrega ninguna protección
// propia: si alguien llega hasta acá sin serlo, el primer fetch (listar) le
// devuelve 403 con el mismo mensaje que las otras tres, y esta pantalla lo
// muestra como cualquier otro error.

// Mismo motivo que la duplicación de `Estado` en VistaListado.tsx: los tipos
// de lib/cotizador/equipo.ts y lib/cotizador/usuarios.ts arrancan con
// `import 'server-only'` — un componente de cliente no puede importarlos.
// Se repiten acá los mismos valores.
type Rol = 'vendedor' | 'superadmin';
type Estado = 'invitada' | 'vencida' | 'activa' | 'desactivada';

type FilaEquipo = {
  id: string;
  correo: string;
  nombre: string;
  rol: Rol;
  activo: boolean;
  estado: Estado;
  ultimo_acceso: string | null;
};

const ETIQUETAS_ESTADO: Record<Estado, string> = {
  invitada: 'Invitada',
  vencida: 'Invitación vencida',
  activa: 'Activa',
  desactivada: 'Desactivada',
};

// Mismo patrón de pastilla que `estiloEstado` en VistaListado.tsx (Paso 3
// del brief de esa tarea): se sigue ese, no se inventa uno nuevo. Invitada
// en neutro (aún no pasó nada), vencida en ámbar (necesita acción: hay que
// reenviarla), activa en verde, desactivada en gris.
function estiloEstado(estado: Estado): string {
  switch (estado) {
    case 'activa':
      return 'bg-emerald-100 text-emerald-800';
    case 'vencida':
      return 'bg-amber-100 text-amber-800';
    case 'desactivada':
      return 'bg-gray-200 text-gray-700';
    default:
      return 'bg-[color:var(--carta-border)]/50 text-navy';
  }
}

// Sólo estos dos estados tienen una invitación pendiente de que alguien la
// abra. A quien ya entró (estado 'activa' o 'desactivada') no se le
// "reenvía" nada: `reenviarInvitacion` (lib/cotizador/equipo.ts) genera un
// enlace nuevo de fijar clave, y si esa persona ya tiene una, mandárselo de
// nuevo la invitaría a pisar su propia clave sin haberlo pedido. La ruta
// también lo rechaza (motivo 'ya_activo'), pero no tiene sentido ofrecer acá
// un botón que el servidor va a devolver como error.
const ESTADOS_CON_INVITACION_PENDIENTE: Estado[] = ['invitada', 'vencida'];

function formatearFecha(iso: string | null): string {
  if (!iso) return '—';
  const f = new Date(iso);
  if (Number.isNaN(f.getTime())) return iso;
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${dos(f.getDate())}/${dos(f.getMonth() + 1)}/${f.getFullYear()}`;
}

type Mensaje = { tipo: 'ok' | 'aviso' | 'error'; texto: string };

type Props = {
  // Token anti-CSRF vigente, para las tres acciones que escriben (invitar,
  // reenviar, estado). Mismo mecanismo que usa VistaListado.
  obtenerCsrf: () => string | null;
  // Mismo mecanismo que ya tiene Panel para un 401 a mitad de trabajo.
  onSesionInvalida: () => void;
};

export function VistaEquipo({ obtenerCsrf, onSesionInvalida }: Props) {
  const [equipo, setEquipo] = useState<FilaEquipo[] | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');

  const [correo, setCorreo] = useState('');
  const [nombre, setNombre] = useState('');
  const [esSuperadmin, setEsSuperadmin] = useState(false);
  const [invitando, setInvitando] = useState(false);
  const [invitarError, setInvitarError] = useState('');
  // Distinto de `invitarError`: la invitación SÍ se creó (la persona ya
  // está en la tabla, más abajo, en la lista) pero el correo que se la
  // avisa no salió. Ver la nota grande más abajo, en `invitar`.
  const [invitarAviso, setInvitarAviso] = useState('');

  // Una fila a la vez, mismo criterio que VistaListado: es una herramienta
  // de uso diario de un equipo chico.
  const [procesandoId, setProcesandoId] = useState<string | null>(null);
  const [mensajesFila, setMensajesFila] = useState<Record<string, Mensaje>>({});

  async function cargar(estaCancelado: () => boolean = () => false) {
    setCargando(true);
    setError('');
    try {
      const res = await fetch('/api/equipo/listar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const datos = await res.json();
      if (estaCancelado()) return;
      if (!res.ok || !datos.ok) {
        if (res.status === 401) onSesionInvalida();
        setError(datos.error ?? `Error ${res.status}`);
        setEquipo([]);
        return;
      }
      setEquipo((datos.equipo ?? []) as FilaEquipo[]);
    } catch {
      if (!estaCancelado()) {
        setError('Fallo de red.');
        setEquipo([]);
      }
    } finally {
      if (!estaCancelado()) setCargando(false);
    }
  }

  useEffect(() => {
    let cancelado = false;
    void cargar(() => cancelado);
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sólo al montar.
  }, []);

  // El correo que no sale es el modo de fallo más probable de esta
  // pantalla (ver el brief de la Tarea 6): `/invitar` puede responder
  // `{ ok: true, correoEnviado: false }` — la fila YA quedó creada (está en
  // la lista de acá abajo desde el próximo `cargar`), pero la persona nunca
  // recibió el enlace para fijar su clave. Si esta pantalla tratara eso
  // como un éxito silencioso, quien invitó creería que la otra persona ya
  // se enteró, cuando en realidad quedó en el limbo hasta que alguien note
  // el estado "Invitada" sin que nunca haya entrado. Por eso el aviso es un
  // mensaje aparte, visible, que dice qué pasó (no salió el correo) y qué
  // hacer (reenviar la invitación desde la fila).
  async function invitar(e: React.FormEvent) {
    e.preventDefault();
    setInvitarError('');
    setInvitarAviso('');
    setInvitando(true);
    try {
      const csrf = obtenerCsrf();
      const res = await fetch('/api/equipo/invitar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({ correo, nombre, rol: esSuperadmin ? 'superadmin' : 'vendedor' }),
      });
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        if (res.status === 401) {
          onSesionInvalida();
          return;
        }
        setInvitarError(datos.error ?? `Error ${res.status}`);
        return;
      }
      setCorreo('');
      setNombre('');
      setEsSuperadmin(false);
      if (!datos.correoEnviado) {
        setInvitarAviso(
          `${nombre || 'Esa persona'} ya quedó creada, pero no se pudo enviar el correo de invitación. ` +
            'Reenviale la invitación desde la fila, más abajo.',
        );
      }
      await cargar();
    } catch {
      setInvitarError('Fallo de red.');
    } finally {
      setInvitando(false);
    }
  }

  async function reenviar(id: string) {
    setProcesandoId(id);
    try {
      const csrf = obtenerCsrf();
      const res = await fetch('/api/equipo/reenviar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({ id }),
      });
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        if (res.status === 401) {
          onSesionInvalida();
          return;
        }
        setMensajesFila((m) => ({ ...m, [id]: { tipo: 'error', texto: datos.error ?? `Error ${res.status}` } }));
        return;
      }
      // Mismo caso que en `invitar`: reenviado no siempre significa que el
      // correo salió.
      setMensajesFila((m) => ({
        ...m,
        [id]: datos.correoEnviado
          ? { tipo: 'ok', texto: 'Invitación reenviada.' }
          : { tipo: 'aviso', texto: 'No se pudo enviar el correo. Probá de nuevo en un momento.' },
      }));
      await cargar();
    } catch {
      setMensajesFila((m) => ({ ...m, [id]: { tipo: 'error', texto: 'Fallo de red.' } }));
    } finally {
      setProcesandoId(null);
    }
  }

  async function cambiarActivo(fila: FilaEquipo) {
    setProcesandoId(fila.id);
    try {
      const csrf = obtenerCsrf();
      const res = await fetch('/api/equipo/estado', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({ id: fila.id, activo: !fila.activo }),
      });
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        if (res.status === 401) {
          onSesionInvalida();
          return;
        }
        setMensajesFila((m) => ({
          ...m,
          [fila.id]: { tipo: 'error', texto: datos.error ?? `Error ${res.status}` },
        }));
        return;
      }
      await cargar();
    } catch {
      setMensajesFila((m) => ({ ...m, [fila.id]: { tipo: 'error', texto: 'Fallo de red.' } }));
    } finally {
      setProcesandoId(null);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={invitar} className="space-y-3 rounded-xl border border-[var(--carta-border)] p-4">
        <h2 className="font-display text-sm text-navy">Invitar a alguien</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="equipo-correo" className="block text-xs font-medium uppercase tracking-wide text-teal">
              Correo
            </label>
            <input
              id="equipo-correo"
              type="email"
              required
              value={correo}
              onChange={(e) => setCorreo(e.target.value)}
              placeholder="persona@luxe.cr"
              className="mt-2 w-full rounded-lg border border-[var(--carta-border)] bg-white px-4 py-2.5 text-sm text-navy placeholder:text-teal/60"
            />
          </div>
          <div>
            <label htmlFor="equipo-nombre" className="block text-xs font-medium uppercase tracking-wide text-teal">
              Nombre
            </label>
            <input
              id="equipo-nombre"
              type="text"
              required
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="Nombre y apellido"
              className="mt-2 w-full rounded-lg border border-[var(--carta-border)] bg-white px-4 py-2.5 text-sm text-navy placeholder:text-teal/60"
            />
          </div>
        </div>
        <div>
          <label htmlFor="equipo-superadmin" className="flex items-center gap-2 text-sm text-navy">
            <input
              id="equipo-superadmin"
              type="checkbox"
              checked={esSuperadmin}
              onChange={(e) => setEsSuperadmin(e.target.checked)}
              aria-describedby="equipo-superadmin-ayuda"
              className="h-4 w-4 rounded border-[var(--carta-border)]"
            />
            Es superadmin
          </label>
          {/* Advertencia del brief: nadie debería marcar esto sin saber qué
              concede. Un superadmin puede invitar y desactivar a cualquier
              otra persona del equipo, incluida quien lo marcó. */}
          <p id="equipo-superadmin-ayuda" className="mt-1 text-xs text-teal">
            Un superadmin puede invitar y desactivar a otras personas del equipo.
          </p>
        </div>
        {invitarError && (
          <p role="alert" className="text-sm text-red-700">
            {invitarError}
          </p>
        )}
        {invitarAviso && (
          <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {invitarAviso}
          </p>
        )}
        <button
          type="submit"
          disabled={invitando}
          className="rounded-lg bg-navy px-4 py-2.5 text-sm font-medium text-beige hover:bg-teal disabled:opacity-40"
        >
          {invitando ? 'Enviando…' : 'Enviar invitación'}
        </button>
      </form>

      {cargando && <p className="text-xs text-teal/70">Cargando…</p>}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}

      {equipo !== null && equipo.length === 0 && !cargando && !error && (
        <p className="text-sm text-teal">Todavía no hay nadie en el equipo.</p>
      )}

      {equipo !== null && equipo.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-[var(--carta-border)]">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-[var(--carta-fill)] text-xs uppercase tracking-wide text-teal">
              <tr>
                <th className="px-3 py-2">Correo</th>
                <th className="px-3 py-2">Nombre</th>
                <th className="px-3 py-2">Rol</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">Último acceso</th>
                <th className="px-3 py-2">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--carta-border)]">
              {equipo.map((fila) => {
                const enProceso = procesandoId === fila.id;
                const mensaje = mensajesFila[fila.id];
                const puedeReenviar = ESTADOS_CON_INVITACION_PENDIENTE.includes(fila.estado);
                return (
                  <tr key={fila.id}>
                    <td className="px-3 py-2 align-top text-navy">{fila.correo}</td>
                    <td className="px-3 py-2 align-top text-navy">{fila.nombre}</td>
                    <td className="px-3 py-2 align-top text-teal">
                      {fila.rol === 'superadmin' ? 'Superadmin' : 'Vendedor'}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${estiloEstado(fila.estado)}`}>
                        {ETIQUETAS_ESTADO[fila.estado] ?? fila.estado}
                      </span>
                      {mensaje && (
                        <p
                          role="alert"
                          className={`mt-1 max-w-[16rem] text-xs ${
                            mensaje.tipo === 'error'
                              ? 'text-red-700'
                              : mensaje.tipo === 'aviso'
                                ? 'text-amber-700'
                                : 'text-teal'
                          }`}
                        >
                          {mensaje.texto}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top text-teal">{formatearFecha(fila.ultimo_acceso)}</td>
                    <td className="px-3 py-2 align-top">
                      <div className="flex flex-wrap items-center gap-2">
                        {/* A quien ya entró no se le reenvía nada: le
                            borraría el acceso al pisarle la clave con un
                            enlace nuevo que nunca pidió — ver
                            ESTADOS_CON_INVITACION_PENDIENTE, arriba. */}
                        {puedeReenviar && (
                          <button
                            type="button"
                            disabled={enProceso}
                            onClick={() => void reenviar(fila.id)}
                            className="rounded-lg border border-[var(--carta-border)] px-2 py-1 text-xs text-navy hover:bg-[var(--carta-fill)] disabled:opacity-40"
                          >
                            Reenviar invitación
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={enProceso}
                          onClick={() => void cambiarActivo(fila)}
                          className="rounded-lg border border-[var(--carta-border)] px-2 py-1 text-xs text-navy hover:bg-[var(--carta-fill)] disabled:opacity-40"
                        >
                          {fila.activo ? 'Desactivar' : 'Activar'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
