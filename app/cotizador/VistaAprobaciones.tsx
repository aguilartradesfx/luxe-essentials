'use client';

import { useEffect, useState } from 'react';
import type { DescuentoPersonalizado, GrupoDescuento } from '@/lib/cotizador/tipos';
import { GRUPOS } from '@/lib/cotizador/tipos';
import { ETIQUETAS_GRUPO, formatearColones, formatearDescuentoPersonalizado, formatearEspera } from './formato';

// Fase 5 (descuento con aprobación): la pestaña "Aprobaciones". Sólo la ve
// un superadmin de VERDAD -- "de verdad" porque, aunque `Panel` sólo dibuja
// el botón que lleva acá cuando `rol === 'superadmin'` (ver el comentario
// junto a esa pestaña en Panel.tsx), esa condición es cosmética: las tres
// rutas de app/api/cotizacion/{pendientes,aprobar,rechazar}/route.ts releen
// la fila de quien hace la petición en la base antes de actuar
// (`autorizarSuperadmin`, lib/cotizador/equipo.ts) y devuelven 403 si no es
// superadmin ahora mismo. Este componente no agrega ninguna protección
// propia -- mismo criterio, exacto, que VistaEquipo.tsx: si alguien llega
// hasta acá sin serlo, el primer fetch (pendientes) le devuelve 403 con el
// mismo mensaje, y esta pantalla lo muestra como cualquier otro error.

type ClienteFila = { nombre?: string; empresa?: string; email?: string };

type FilaPendiente = {
  id: string;
  numero: string;
  created_at: string;
  cliente: ClienteFila;
  totales: { total?: number };
  descuento_personalizado: DescuentoPersonalizado;
  solicitado_por: string | null;
};

type Mensaje = { tipo: 'ok' | 'error'; texto: string };

// Mismo motivo que la duplicación de `descuentosIguales` -- vive en
// lib/cotizador/aprobacion.ts, que arranca con `import 'server-only'` y no
// se puede traer a un componente de cliente. Se repite acá una versión
// mínima, sólo para lo que esta pantalla necesita: saber si lo que el
// superadmin está por confirmar es de verdad distinto de lo pedido, para
// decidir qué texto poner en el botón de confirmar (ver más abajo, el
// requisito central del diseño: "que aprobar con un porcentaje distinto del
// pedido sea evidente, no un descuido").
function mismoDescuento(a: DescuentoPersonalizado, b: DescuentoPersonalizado): boolean {
  const aGeneral = 'general' in a;
  const bGeneral = 'general' in b;
  if (aGeneral !== bGeneral) return false;
  if (aGeneral) return (a as { general: number }).general === (b as { general: number }).general;
  const fa = (a as { familias: Partial<Record<string, number>> }).familias;
  const fb = (b as { familias: Partial<Record<string, number>> }).familias;
  const clavesA = Object.keys(fa).sort();
  const clavesB = Object.keys(fb).sort();
  if (clavesA.length !== clavesB.length) return false;
  return clavesA.every((clave, i) => clave === clavesB[i] && fa[clave] === fb[clave]);
}

// Los grupos que de verdad se pidieron, en el orden fijo de `GRUPOS` (no el
// de `Object.entries`, que no está garantizado) -- es lo que el formulario
// de edición necesita mostrar: sólo esas familias, nunca las seis, porque
// agregar una familia nueva que nadie pidió es otra conversación (volver
// con el vendedor), no algo que este formulario deba ofrecer.
function familiasPedidas(dp: DescuentoPersonalizado): GrupoDescuento[] {
  if ('general' in dp) return [];
  return GRUPOS.filter((g) => dp.familias[g] !== undefined);
}

type Props = {
  // Token anti-CSRF vigente, para las dos acciones que escriben (aprobar,
  // rechazar). Mismo mecanismo que usa VistaEquipo/VistaListado.
  obtenerCsrf: () => string | null;
  // Mismo mecanismo que ya tiene Panel para un 401 a mitad de trabajo.
  onSesionInvalida: () => void;
};

export function VistaAprobaciones({ obtenerCsrf, onSesionInvalida }: Props) {
  const [pendientes, setPendientes] = useState<FilaPendiente[] | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');

  // Una fila a la vez -- mismo criterio que VistaEquipo/VistaListado: es
  // una herramienta de uso diario de un equipo chico.
  const [procesandoId, setProcesandoId] = useState<string | null>(null);
  const [mensajesFila, setMensajesFila] = useState<Record<string, Mensaje>>({});
  // Una fila resuelta (aprobada/rechazada) SALE de `pendientes` -- a
  // diferencia de VistaEquipo/VistaListado, acá no tiene sentido dejarla
  // pintada con un mensaje al lado, porque ya no es una solicitud
  // pendiente. La confirmación de qué pasó (y si el porcentaje cambió, el
  // hecho más importante de destacar) va en un aviso aparte, arriba de la
  // lista, no atado a una fila que ya no existe.
  const [avisoGlobal, setAvisoGlobal] = useState<Mensaje | null>(null);

  // Qué fila tiene abierto el formulario de "cambiar % y aprobar". `null`
  // en reposo -- cerrado por defecto, para que aprobar tal cual (el camino
  // más común) no tenga que mirar un formulario que no le hace falta.
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [valoresEdicion, setValoresEdicion] = useState<Partial<Record<GrupoDescuento | 'general', string>>>({});

  // Qué fila tiene abierto el formulario de rechazo, con su motivo.
  const [rechazandoId, setRechazandoId] = useState<string | null>(null);
  const [motivoRechazo, setMotivoRechazo] = useState('');

  async function cargar(estaCancelado: () => boolean = () => false) {
    setCargando(true);
    setError('');
    try {
      const res = await fetch('/api/cotizacion/pendientes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const datos = await res.json();
      if (estaCancelado()) return;
      if (!res.ok || !datos.ok) {
        if (res.status === 401) onSesionInvalida();
        setError(datos.error ?? `Error ${res.status}`);
        setPendientes([]);
        return;
      }
      setPendientes((datos.cotizaciones ?? []) as FilaPendiente[]);
    } catch {
      if (!estaCancelado()) {
        setError('Fallo de red.');
        setPendientes([]);
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

  function abrirEdicion(fila: FilaPendiente) {
    setEditandoId(fila.id);
    setRechazandoId(null);
    // Se prellena con lo YA pedido -- el superadmin edita desde ahí, no
    // desde cero. Que el valor arranque igual al pedido no es un problema:
    // si lo manda sin tocarlo, `mismoDescuento` lo detecta y no hay ningún
    // "cambio" que destacar (ver `enviarAprobacion`, abajo).
    if ('general' in fila.descuento_personalizado) {
      setValoresEdicion({ general: String(fila.descuento_personalizado.general) });
    } else {
      const iniciales: Partial<Record<GrupoDescuento, string>> = {};
      for (const g of familiasPedidas(fila.descuento_personalizado)) {
        iniciales[g] = String(fila.descuento_personalizado.familias[g]);
      }
      setValoresEdicion(iniciales);
    }
  }

  function cerrarEdicion() {
    setEditandoId(null);
    setValoresEdicion({});
  }

  // La forma final que armaría la edición en curso -- misma forma
  // (`general`/`familias`) que lo pedido, para no ofrecerle al superadmin
  // agregar una familia que nadie pidió. `undefined` si algún campo no es
  // un número válido: el botón de confirmar se deshabilita en ese caso (ver
  // el JSX).
  function descuentoEditado(fila: FilaPendiente): DescuentoPersonalizado | undefined {
    if ('general' in fila.descuento_personalizado) {
      const n = Number((valoresEdicion.general ?? '').trim());
      return Number.isFinite(n) && n >= 0 && n < 100 ? { general: n } : undefined;
    }
    const familias: Partial<Record<GrupoDescuento, number>> = {};
    for (const g of familiasPedidas(fila.descuento_personalizado)) {
      const n = Number((valoresEdicion[g] ?? '').trim());
      if (!Number.isFinite(n) || n < 0 || n >= 100) return undefined;
      familias[g] = n;
    }
    return { familias };
  }

  async function enviarAprobacion(fila: FilaPendiente, nuevoDescuento?: DescuentoPersonalizado) {
    setProcesandoId(fila.id);
    try {
      const csrf = obtenerCsrf();
      const res = await fetch('/api/cotizacion/aprobar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({ id: fila.id, ...(nuevoDescuento ? { descuentoPersonalizado: nuevoDescuento } : {}) }),
      });
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        if (res.status === 401) {
          onSesionInvalida();
          return;
        }
        setMensajesFila((m) => ({ ...m, [fila.id]: { tipo: 'error', texto: datos.error ?? `Error ${res.status}` } }));
        return;
      }
      cerrarEdicion();
      setPendientes((prev) => (prev ?? []).filter((f) => f.id !== fila.id));
      // Ronda de correcciones: el aviso que queda tras aprobar tiene que
      // decir, sin ambigüedad, si el porcentaje cambió -- es el mismo hecho
      // que el diseño dice que hay que destacar en el correo al vendedor
      // ("pidió 20%, se aprobó 12%"), y esta pantalla no debe decir menos.
      setAvisoGlobal({
        tipo: 'ok',
        texto: datos.cambioPorcentaje
          ? `Aprobada ${datos.numero} con el porcentaje cambiado.`
          : `Aprobada ${datos.numero} tal cual se pidió.`,
      });
    } catch {
      setMensajesFila((m) => ({ ...m, [fila.id]: { tipo: 'error', texto: 'Fallo de red.' } }));
    } finally {
      setProcesandoId(null);
    }
  }

  async function enviarRechazo(fila: FilaPendiente) {
    const motivo = motivoRechazo.trim();
    if (!motivo) return;
    setProcesandoId(fila.id);
    try {
      const csrf = obtenerCsrf();
      const res = await fetch('/api/cotizacion/rechazar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({ id: fila.id, motivo }),
      });
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        if (res.status === 401) {
          onSesionInvalida();
          return;
        }
        setMensajesFila((m) => ({ ...m, [fila.id]: { tipo: 'error', texto: datos.error ?? `Error ${res.status}` } }));
        return;
      }
      setRechazandoId(null);
      setMotivoRechazo('');
      setPendientes((prev) => (prev ?? []).filter((f) => f.id !== fila.id));
      setAvisoGlobal({ tipo: 'ok', texto: `Rechazada ${datos.numero}.` });
    } catch {
      setMensajesFila((m) => ({ ...m, [fila.id]: { tipo: 'error', texto: 'Fallo de red.' } }));
    } finally {
      setProcesandoId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-sm text-navy">Descuentos esperando aprobación</h2>
        <p className="mt-1 text-xs text-teal">
          Cada cotización de acá tiene un descuento fuera de las escalas automáticas. No sale al
          cliente hasta que la apruebes, cambies el porcentaje, o la rechaces.
        </p>
      </div>

      {avisoGlobal && (
        <p
          role="alert"
          className={`rounded-lg px-3 py-2 text-xs ${
            avisoGlobal.tipo === 'error' ? 'bg-red-50 text-red-800' : 'bg-emerald-50 text-emerald-800'
          }`}
        >
          {avisoGlobal.texto}
        </p>
      )}
      {cargando && <p className="text-xs text-teal/70">Cargando…</p>}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}

      {pendientes !== null && pendientes.length === 0 && !cargando && !error && (
        <p className="text-sm text-teal">No hay ninguna solicitud esperando.</p>
      )}

      {pendientes !== null && pendientes.length > 0 && (
        <ul className="space-y-3">
          {pendientes.map((fila) => {
            const enProceso = procesandoId === fila.id;
            const mensaje = mensajesFila[fila.id];
            const nombre = fila.cliente?.nombre || 'Sin nombre';
            const empresa = fila.cliente?.empresa;
            const editando = editandoId === fila.id;
            const rechazando = rechazandoId === fila.id;
            const editado = editando ? descuentoEditado(fila) : undefined;
            // El requisito central del diseño: que confirmar con un
            // porcentaje distinto sea EVIDENTE, no un descuido. `cambia`
            // compara lo que el formulario armaría contra lo pedido -- si
            // hay diferencia, el botón de confirmar lo dice con los dos
            // números, no con un genérico "Confirmar".
            const cambia = editado !== undefined && !mismoDescuento(editado, fila.descuento_personalizado);

            return (
              <li key={fila.id} className="rounded-xl border border-[var(--carta-border)] bg-[var(--carta-fill)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm text-navy">
                      {nombre}
                      {empresa ? ` · ${empresa}` : ''}
                    </p>
                    <p className="text-xs text-teal">{fila.numero}</p>
                    <p className="mt-1 text-sm font-medium text-navy">
                      {formatearColones(fila.totales?.total ?? 0)}
                    </p>
                  </div>
                  <div className="text-right text-xs text-teal">
                    <p>
                      Pedido por <span className="font-medium text-navy">{fila.solicitado_por || 'desconocido'}</span>
                    </p>
                    <p className="mt-0.5">Esperando hace {formatearEspera(fila.created_at)}</p>
                  </div>
                </div>

                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800">
                  Descuento pedido: {formatearDescuentoPersonalizado(fila.descuento_personalizado)}
                </p>

                {!editando && !rechazando && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={enProceso}
                      onClick={() => void enviarAprobacion(fila)}
                      className="rounded-lg bg-navy px-3 py-1.5 text-xs font-medium text-beige hover:bg-navy/90 disabled:opacity-40"
                    >
                      Aprobar tal cual ({formatearDescuentoPersonalizado(fila.descuento_personalizado)})
                    </button>
                    <button
                      type="button"
                      disabled={enProceso}
                      onClick={() => abrirEdicion(fila)}
                      className="rounded-lg border border-[var(--carta-border)] px-3 py-1.5 text-xs font-medium text-navy hover:bg-navy hover:text-beige disabled:opacity-40"
                    >
                      Cambiar % y aprobar
                    </button>
                    <button
                      type="button"
                      disabled={enProceso}
                      onClick={() => {
                        setRechazandoId(fila.id);
                        setEditandoId(null);
                        setMotivoRechazo('');
                      }}
                      className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-50 disabled:opacity-40"
                    >
                      Rechazar
                    </button>
                  </div>
                )}

                {editando && (
                  <div className="mt-3 space-y-2 rounded-lg border border-[var(--carta-border)] bg-white p-3">
                    {'general' in fila.descuento_personalizado ? (
                      <label htmlFor={`edicion-general-${fila.id}`} className="block text-xs text-teal">
                        Nuevo porcentaje general
                        <input
                          id={`edicion-general-${fila.id}`}
                          type="number"
                          min={0}
                          max={100}
                          step="0.01"
                          value={valoresEdicion.general ?? ''}
                          onChange={(e) => setValoresEdicion((v) => ({ ...v, general: e.target.value }))}
                          className="mt-1 w-full rounded-lg border border-[var(--carta-border)] bg-white px-3 py-2 text-sm text-navy"
                        />
                      </label>
                    ) : (
                      familiasPedidas(fila.descuento_personalizado).map((g) => (
                        <label
                          key={g}
                          htmlFor={`edicion-${g}-${fila.id}`}
                          className="flex items-center justify-between gap-3 text-xs text-teal"
                        >
                          {ETIQUETAS_GRUPO[g]}
                          <input
                            id={`edicion-${g}-${fila.id}`}
                            type="number"
                            min={0}
                            max={100}
                            step="0.01"
                            value={valoresEdicion[g] ?? ''}
                            onChange={(e) => setValoresEdicion((v) => ({ ...v, [g]: e.target.value }))}
                            className="w-24 rounded-lg border border-[var(--carta-border)] bg-white px-2 py-1.5 text-sm text-navy"
                          />
                        </label>
                      ))
                    )}

                    {/* El requisito central del diseño, en pantalla: un
                        aviso que no se puede pasar por alto, y el botón de
                        confirmar repite los dos números en su propio
                        texto -- no hace falta leer el aviso para
                        enterarse, el botón ya lo dice. */}
                    {cambia && editado && (
                      <p role="alert" className="rounded-lg bg-amber-100 px-3 py-2 text-xs font-semibold text-amber-900">
                        Vas a aprobar {formatearDescuentoPersonalizado(editado)} en vez de lo pedido (
                        {formatearDescuentoPersonalizado(fila.descuento_personalizado)}).
                      </p>
                    )}

                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={enProceso || editado === undefined}
                        onClick={() => editado && void enviarAprobacion(fila, editado)}
                        className="rounded-lg bg-navy px-3 py-1.5 text-xs font-medium text-beige disabled:opacity-40"
                      >
                        {cambia && editado
                          ? `Aprobar con ${formatearDescuentoPersonalizado(editado)} (pedido: ${formatearDescuentoPersonalizado(fila.descuento_personalizado)})`
                          : 'Aprobar (sin cambios)'}
                      </button>
                      <button
                        type="button"
                        onClick={cerrarEdicion}
                        className="rounded-lg border border-[var(--carta-border)] px-3 py-1.5 text-xs text-navy"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}

                {rechazando && (
                  <div className="mt-3 space-y-2 rounded-lg border border-[var(--carta-border)] bg-white p-3">
                    <label htmlFor={`motivo-rechazo-${fila.id}`} className="block text-xs text-teal">
                      Motivo del rechazo
                      <input
                        id={`motivo-rechazo-${fila.id}`}
                        value={motivoRechazo}
                        onChange={(e) => setMotivoRechazo(e.target.value)}
                        placeholder="¿Por qué se rechaza?"
                        className="mt-1 w-full rounded-lg border border-[var(--carta-border)] bg-white px-3 py-2 text-sm text-navy"
                      />
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={enProceso || motivoRechazo.trim().length === 0}
                        onClick={() => void enviarRechazo(fila)}
                        className="rounded-lg bg-navy px-3 py-1.5 text-xs font-medium text-beige disabled:opacity-40"
                      >
                        Confirmar rechazo
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRechazandoId(null);
                          setMotivoRechazo('');
                        }}
                        className="rounded-lg border border-[var(--carta-border)] px-3 py-1.5 text-xs text-navy"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}

                {mensaje && (
                  <p
                    role="alert"
                    className={`mt-2 text-xs ${mensaje.tipo === 'error' ? 'text-red-700' : 'text-teal'}`}
                  >
                    {mensaje.texto}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
