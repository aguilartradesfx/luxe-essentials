'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatearFecha } from './formato';

// La pestaña "Historial de campañas" (encargo del dueño, punto 2). Antes
// esto vivía como una cola al fondo de la pantalla de armar una campaña
// (VistaCampanas.tsx) -- había que bajar hasta el final para ver qué se
// había mandado, y el aviso de "hay una campaña sin terminar" competía por
// espacio con la zona, la selección y el botón de enviar.
//
// POR QUÉ UNA PESTAÑA PROPIA Y NO UNA SECCIÓN DENTRO DE "CAMPAÑAS": armar
// una campaña y revisar lo enviado son dos tareas distintas -- se hacen en
// momentos distintos (una vez al armar, muchas veces después mientras se
// manda) y con la cabeza en cosas distintas (elegir a quién escribirle y
// qué decir vs. controlar que un envío de horas siga su curso, o pararlo).
// Este mismo panel YA separa así "Crear" (armar una cotización) de
// "Cotizaciones" (verlas, filtrarlas, actuar sobre una vieja) -- son la
// misma clase de par de tareas, y ya se resolvió con dos pestañas, no con
// una sección plegable dentro de la otra. Un desplegable escondería el
// historial detrás de un clic extra cada vez que alguien sólo quiere
// chequear si una campaña de ayer ya terminó -- justamente lo que el dueño
// pidió que dejara de pasar.
//
// Acá vive todo lo que el progreso de una campaña EN CURSO necesita:
// verlo, retomarlo si quedó a medias, y cancelarlo (punto 1 del encargo) --
// sin importar en qué pestaña, ni en qué sesión, se haya creado. La única
// excepción es la campaña que VistaCampanas.tsx ACABA de crear en esta
// misma visita: esa sigue mostrando su propio progreso ahí mismo, como
// cortesía inmediata para quien recién apretó "enviar" -- no una segunda
// copia de esta pantalla. Las dos pueden mandar tandas de la misma campaña
// a la vez sin pisarse: `campanas_reclamar_pendientes` (migración 0019/0020)
// reparte los pendientes bajo lock de fila entre cualquier cantidad de
// llamadas concurrentes -- es el mismo mecanismo pensado, desde el
// principio, para que "dos tandas salen a la vez" nunca duplique un envío.
//
// Mismo criterio de autorización que VistaCampanas.tsx (y el resto de
// app/api/campanas/*): las rutas releen la fila de quien pide con
// `autorizarSuperadmin` y devuelven 403 a quien no es superadmin de verdad.
// Este componente no agrega ninguna protección propia.

// Mismo motivo que la duplicación de tipos en VistaCampanas.tsx: lib/campanas/*
// arranca con `import 'server-only'`.
const PLANTILLAS = ['inicial', 'seguimiento_1', 'seguimiento_2', 'seguimiento_3'] as const;
const PLANTILLA_PERSONALIZADA = 'personalizada' as const;
type PlantillaCampana = (typeof PLANTILLAS)[number] | typeof PLANTILLA_PERSONALIZADA;

const ETIQUETAS_PLANTILLA: Record<PlantillaCampana, string> = {
  inicial: 'Correo inicial',
  seguimiento_1: 'Primer seguimiento',
  seguimiento_2: 'Segundo seguimiento',
  seguimiento_3: 'Tercer seguimiento (cierre)',
  personalizada: 'HTML personalizado',
};

type ProgresoCampana = { total: number; enviados: number; fallidos: number; pendientes: number };
type FilaCampana = {
  id: string;
  // Punto 2 del encargo (hallazgo importante, revisión final): `null` para
  // una campaña creada antes de la migración 0022 -- se pinta "—" en ese
  // caso, ver la columna "Zona" más abajo.
  zona: string | null;
  plantilla: PlantillaCampana;
  asunto: string;
  creadoPor: string;
  creadoAt: string;
  progreso: ProgresoCampana;
  canceladaAt: string | null;
  canceladaPor: string | null;
};

type Mensaje = { tipo: 'ok' | 'error' | 'aviso'; texto: string };

type Props = {
  // Token anti-CSRF vigente, para las dos acciones que escriben (retomar el
  // envío, cancelar). Mismo mecanismo que ya usan VistaCampanas/VistaEquipo/
  // VistaAprobaciones/VistaListado.
  obtenerCsrf: () => string | null;
  // Mismo mecanismo que ya tiene Panel para un 401 a mitad de trabajo.
  onSesionInvalida: () => void;
};

export function VistaHistorialCampanas({ obtenerCsrf, onSesionInvalida }: Props) {
  const [campanas, setCampanas] = useState<FilaCampana[] | null>(null);
  const [cargando, setCargando] = useState(false);
  const [errorCampanas, setErrorCampanas] = useState('');
  const [mensaje, setMensaje] = useState<Mensaje | null>(null);

  // La campaña que en ESTE momento está mandando tandas desde esta pantalla
  // (un "Retomar" en curso) -- `null` en reposo. Sólo una a la vez: mientras
  // hay una activa, el resto de los botones de retomar/cancelar de las
  // OTRAS filas quedan deshabilitados (no porque sería inseguro que dos
  // corrieran a la vez -- no lo es, ver el comentario grande del
  // encabezado -- sino para no mostrar dos barras de progreso peleándose
  // por la atención). Cancelar la MISMA fila que se está retomando sigue
  // permitido: es exactamente el caso que el punto 1 del encargo pide que
  // funcione bien.
  const [idEnviando, setIdEnviando] = useState<string | null>(null);
  // Progreso LOCAL de la fila que se está retomando ahora mismo -- se
  // actualiza tanda a tanda, sin esperar a un nuevo listado completo (mismo
  // patrón que `progresoEnCurso` en VistaCampanas.tsx). Se descarta apenas
  // termina (favorable o no) y se refresca el listado entero, que pasa a
  // ser la fuente de verdad de nuevo.
  const [progresoLocal, setProgresoLocal] = useState<ProgresoCampana | null>(null);

  // La campaña cuya confirmación de cancelar está abierta -- `null` si
  // ninguna. Separado de `idEnviando`: cancelar no exige escribir ninguna
  // palabra (no es tan grave como mandar -- ver el comentario junto al
  // diálogo, más abajo), pero sí un clic de confirmación aparte, porque
  // sigue siendo una acción de una sola vía sobre una campaña real.
  const [confirmandoCancelarId, setConfirmandoCancelarId] = useState<string | null>(null);
  const [cancelando, setCancelando] = useState(false);

  const cargarCampanas = useCallback(async () => {
    setCargando(true);
    setErrorCampanas('');
    try {
      const res = await fetch('/api/campanas/listado', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        if (res.status === 401) return onSesionInvalida();
        setErrorCampanas(datos.error ?? `Error ${res.status}`);
        return;
      }
      setCampanas(datos.campanas as FilaCampana[]);
    } catch {
      setErrorCampanas('Fallo de red al consultar el historial de campañas.');
    } finally {
      setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onSesionInvalida` es estable entre renders (viene de Panel).
  }, []);

  useEffect(() => {
    void cargarCampanas();
  }, [cargarCampanas]);

  // Manda tandas de a una hasta que el servidor dice `terminada: true` (o
  // `cancelada: true`, que también implica terminada) -- mismo mecanismo,
  // exacto, que `enviarPorTandas` en VistaCampanas.tsx.
  async function retomar(campanaId: string, progresoActual: ProgresoCampana) {
    setIdEnviando(campanaId);
    setProgresoLocal(progresoActual);
    setMensaje(null);
    try {
      for (;;) {
        let res: Response;
        try {
          res = await fetch('/api/campanas/enviar', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(obtenerCsrf() ? { 'x-csrf-token': obtenerCsrf()! } : {}),
            },
            body: JSON.stringify({ campanaId }),
          });
        } catch {
          setMensaje({ tipo: 'error', texto: 'Fallo de red a mitad del envío. La campaña quedó donde iba -- se puede retomar de nuevo.' });
          return;
        }
        const datos = await res.json();
        if (!res.ok || !datos.ok) {
          if (res.status === 401) return onSesionInvalida();
          setMensaje({ tipo: 'error', texto: `${datos.error ?? `Error ${res.status}`} La campaña quedó donde iba -- se puede retomar de nuevo.` });
          return;
        }
        setProgresoLocal((prev) => {
          const base = prev ?? { total: 0, enviados: 0, fallidos: 0, pendientes: 0 };
          return {
            total: base.total,
            enviados: base.enviados + datos.enviados,
            fallidos: base.fallidos + datos.fallidos,
            pendientes: Math.max(0, base.pendientes - datos.procesados),
          };
        });
        if (datos.cancelada) {
          setMensaje({ tipo: 'aviso', texto: 'Esta campaña se canceló mientras se estaba mandando -- el resto no se mandó.' });
          return;
        }
        if (datos.terminada) {
          setMensaje({ tipo: 'ok', texto: 'La campaña terminó de enviarse.' });
          return;
        }
      }
    } finally {
      setIdEnviando(null);
      setProgresoLocal(null);
      await cargarCampanas();
    }
  }

  async function confirmarCancelar() {
    const campanaId = confirmandoCancelarId;
    if (!campanaId) return;
    setCancelando(true);
    setMensaje(null);
    try {
      const csrf = obtenerCsrf();
      const res = await fetch('/api/campanas/cancelar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({ campanaId }),
      });
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        if (res.status === 401) {
          onSesionInvalida();
          return;
        }
        setMensaje({ tipo: 'error', texto: datos.error ?? `Error ${res.status}` });
        return;
      }
      setMensaje({ tipo: 'ok', texto: 'La campaña se canceló. Lo que ya se había mandado sigue enviado; el resto no se va a mandar.' });
      await cargarCampanas();
    } catch {
      setMensaje({ tipo: 'error', texto: 'Fallo de red al cancelar la campaña.' });
    } finally {
      setCancelando(false);
      setConfirmandoCancelarId(null);
    }
  }

  const campanaConfirmando = campanas?.find((c) => c.id === confirmandoCancelarId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-sm text-navy">Historial de campañas</h2>
        <button
          type="button"
          onClick={() => void cargarCampanas()}
          disabled={cargando}
          className="rounded-lg border border-[var(--carta-border)] px-3 py-1.5 text-xs font-medium text-navy hover:bg-[var(--carta-fill)] disabled:opacity-40"
        >
          {cargando ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>

      {errorCampanas && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
          {errorCampanas}
        </p>
      )}
      {mensaje && (
        <p
          role="alert"
          className={`rounded-lg px-3 py-2 text-sm ${
            mensaje.tipo === 'error'
              ? 'bg-red-50 text-red-800'
              : mensaje.tipo === 'aviso'
                ? 'bg-amber-50 text-amber-800'
                : 'bg-emerald-50 text-emerald-800'
          }`}
        >
          {mensaje.texto}
        </p>
      )}

      {campanas && campanas.length === 0 && (
        <p className="text-xs text-teal/70">Todavía no se creó ninguna campaña.</p>
      )}

      {campanas && campanas.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-[var(--carta-border)]">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-[var(--carta-fill)] text-xs uppercase tracking-wide text-teal">
              <tr>
                {/* Hallazgo importante (revisión final, punto 2): con trece
                    zonas y campañas que se retoman días después, "Plantilla"
                    y "Fecha" solas no alcanzan para saber a qué zona ya se
                    le escribió -- dos "Primer seguimiento" de la misma
                    semana se ven idénticas sin esta columna. */}
                <th className="px-3 py-2">Zona</th>
                <th className="px-3 py-2">Plantilla</th>
                <th className="px-3 py-2">Creada por</th>
                <th className="px-3 py-2">Fecha</th>
                <th className="px-3 py-2">Progreso</th>
                <th className="px-3 py-2">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--carta-border)]">
              {campanas.map((c) => {
                const cancelada = c.canceladaAt !== null;
                const enviandoAhora = idEnviando === c.id;
                const progreso = enviandoAhora && progresoLocal ? progresoLocal : c.progreso;
                const otraAccionActiva = idEnviando !== null && idEnviando !== c.id;
                const puedeAccionar = progreso.pendientes > 0 && !cancelada;

                return (
                  <tr key={c.id}>
                    <td className="px-3 py-2 align-top text-navy">{c.zona ?? '—'}</td>
                    <td className="px-3 py-2 align-top text-navy">
                      <p>{ETIQUETAS_PLANTILLA[c.plantilla]}</p>
                      {/* El asunto ya viajaba en la respuesta de /listado
                          (`FilaCampana.asunto`) pero esta pantalla nunca lo
                          pintaba -- hallazgo importante, revisión final,
                          punto 2. */}
                      <p className="mt-0.5 text-xs text-teal">{c.asunto}</p>
                    </td>
                    <td className="px-3 py-2 align-top text-teal">{c.creadoPor}</td>
                    <td className="px-3 py-2 align-top text-teal">{formatearFecha(c.creadoAt)}</td>
                    <td className="px-3 py-2 align-top text-teal">
                      <p>
                        {progreso.enviados}/{progreso.total} enviados
                        {progreso.fallidos > 0 ? `, ${progreso.fallidos} con error` : ''}
                      </p>
                      <p className="mt-0.5">
                        {cancelada
                          ? `Cancelada por ${c.canceladaPor ?? '—'} el ${c.canceladaAt ? formatearFecha(c.canceladaAt) : '—'} -- ${progreso.pendientes} sin mandar.`
                          : progreso.pendientes === 0
                            ? 'Terminada.'
                            : enviandoAhora
                              ? `Enviando… quedan ${progreso.pendientes}.`
                              : `Interrumpida -- quedan ${progreso.pendientes}.`}
                      </p>
                      {enviandoAhora && (
                        <div className="mt-1 h-1.5 w-40 overflow-hidden rounded-full bg-[var(--carta-fill)]" aria-hidden="true">
                          <div
                            className="h-full bg-teal transition-all"
                            style={{
                              width: `${progreso.total === 0 ? 0 : Math.round(((progreso.enviados + progreso.fallidos) / progreso.total) * 100)}%`,
                            }}
                          />
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {puedeAccionar && (
                        <div className="flex flex-wrap gap-2">
                          {!enviandoAhora && (
                            <button
                              type="button"
                              disabled={otraAccionActiva || cancelando}
                              onClick={() => void retomar(c.id, c.progreso)}
                              className="rounded-lg bg-navy px-3 py-1.5 text-xs font-medium text-beige hover:bg-navy/90 disabled:opacity-40"
                            >
                              Retomar
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={otraAccionActiva || cancelando}
                            onClick={() => setConfirmandoCancelarId(c.id)}
                            className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-50 disabled:opacity-40"
                          >
                            Cancelar
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Confirmar cancelar -- un clic de confirmación aparte (no la
          palabra escrita que exige mandar: cancelar frena lo que falta, no
          manda nada nuevo, así que el riesgo es menor -- pero sigue siendo
          una acción de una sola vía sobre una campaña real, así que no
          dispara directo desde la fila). Muestra el progreso actual para
          que quede claro, ANTES de confirmar, cuánto ya salió y cuánto
          quedaría sin mandar. */}
      {campanaConfirmando && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="campanas-cancelar-titulo"
          className="fixed inset-0 z-50 flex items-center justify-center bg-navy/50 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h2 id="campanas-cancelar-titulo" className="font-display text-base text-navy">
              Cancelar campaña
            </h2>
            <p className="mt-2 text-sm text-navy">
              Ya se mandaron <strong>{campanaConfirmando.progreso.enviados}</strong> de{' '}
              <strong>{campanaConfirmando.progreso.total}</strong>. Los <strong>{campanaConfirmando.progreso.pendientes}</strong>{' '}
              restantes NO se van a mandar.
            </p>
            <p className="mt-2 text-xs text-teal">
              Lo ya enviado no se deshace ni se oculta -- esto sólo detiene lo que falta. No se puede deshacer.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmandoCancelarId(null)}
                disabled={cancelando}
                className="rounded-lg border border-[var(--carta-border)] px-3 py-1.5 text-sm text-navy disabled:opacity-40"
              >
                Volver
              </button>
              <button
                type="button"
                disabled={cancelando}
                onClick={() => void confirmarCancelar()}
                className="rounded-lg bg-red-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-40"
              >
                {cancelando ? 'Cancelando…' : 'Sí, cancelar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
