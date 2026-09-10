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

// La cola del envío programado (encargo: "quien abre el panel no puede ver
// la cola"). Mismo motivo que el resto de la duplicación de tipos de este
// archivo: lib/campanas/cola.ts arranca con `import 'server-only'`, así
// que este componente de cliente no puede importar sus tipos -- copia la
// FORMA de lo que ya devuelve app/api/campanas/cola/route.ts.
// 'error' -- hallazgo de producción (2026-09-10): una zona que no se pudo
// consultar contra el CRM (ni con reintento) ya no tumba la pantalla
// entera -- queda en su propia fila, con su motivo, mientras las otras
// doce se siguen mostrando. Ver el comentario grande de
// lib/campanas/cola.ts para el criterio completo.
type EstadoZonaCola = 'terminada' | 'en_curso' | 'espera' | 'error';
type FilaZonaCola = {
  zona: string;
  orden: number;
  estado: EstadoZonaCola;
  campanaId: string | null;
  direccionesTotal: number;
  direccionesEnviadas: number;
  direccionesFallidas: number;
  direccionesPendientes: number;
  error: string | null;
};
type CupoHoyCola = { dia: number; tope: number; reservado: number; disponible: number; diaHabilHoy: boolean };
type ColaProgramadaDatos = {
  zonas: FilaZonaCola[];
  totales: { direcciones: number; enviadas: number; fallidas: number; pendientes: number };
  // `true` si alguna zona quedó en 'error' -- en ese caso `totales` es un
  // PISO, nunca la cifra completa (ver lib/campanas/cola.ts).
  totalIncompleto: boolean;
  zonasConError: string[];
  cupoHoy: CupoHoyCola;
  fechaEstimadaFin: string | null;
};

const ETIQUETAS_ESTADO_ZONA: Record<EstadoZonaCola, string> = {
  terminada: 'Terminada',
  en_curso: 'En curso',
  espera: 'En espera',
  error: 'No se pudo calcular',
};

// Miles con punto, sin decimales -- mismo criterio, exacto, que
// `formatearColones` en formato.ts (no se usa `toLocaleString`: el
// separador que trae el runtime de Node para `es-CR` varía entre
// versiones de ICU).
function formatearNumero(valor: number): string {
  return Math.round(valor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// 'YYYY-MM-DD' -> 'DD/MM/YYYY', por texto -- a propósito, NUNCA pasando
// por `new Date(...)`: esa fecha es de sólo calendario (no trae hora), y
// `new Date('2026-09-25')` la interpreta como medianoche UTC -- en un
// huso con offset negativo (Costa Rica, UTC-6) eso cae la tarde del día
// ANTERIOR en hora local, así que leerla con getDate()/getMonth() (como
// hace `formatearFecha`, pensada para timestamps CON hora) correría el
// día uno para atrás. Partir el string evita el huso horario por
// completo.
function formatearFechaCorta(fechaIso: string): string {
  const [anio, mes, dia] = fechaIso.split('-');
  return `${dia}/${mes}/${anio}`;
}

// La cola del envío programado -- las trece zonas en su orden real, cuál
// está en curso, cuáles terminaron, cuáles esperan, cuánto falta en total
// y una fecha estimada de término. Componente propio, con su propio fetch
// al montar: independiente del interruptor y del historial de abajo, mismo
// criterio que ya separa `InterruptorProgramado` del resto de esta
// pantalla -- una falla acá (GHL caído a mitad de camino) no debería tapar
// ni el interruptor ni el historial.
function ColaProgramada({ onSesionInvalida }: Pick<Props, 'onSesionInvalida'>) {
  const [datos, setDatos] = useState<ColaProgramadaDatos | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');

  const cargar = useCallback(async () => {
    setCargando(true);
    setError('');
    try {
      const res = await fetch('/api/campanas/cola', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const cuerpo = await res.json();
      if (!res.ok || !cuerpo.ok) {
        if (res.status === 401) return onSesionInvalida();
        setError(cuerpo.error ?? `Error ${res.status}`);
        return;
      }
      setDatos({
        zonas: cuerpo.zonas as FilaZonaCola[],
        totales: cuerpo.totales,
        totalIncompleto: Boolean(cuerpo.totalIncompleto),
        zonasConError: (cuerpo.zonasConError as string[] | undefined) ?? [],
        cupoHoy: cuerpo.cupoHoy,
        fechaEstimadaFin: cuerpo.fechaEstimadaFin ?? null,
      });
    } catch {
      setError('Fallo de red al consultar la cola del envío programado.');
    } finally {
      setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onSesionInvalida` es estable entre renders (viene de Panel).
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  return (
    <div className="rounded-xl border border-[var(--carta-border)] bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-sm text-navy">Cola del envío programado</h2>
        <button
          type="button"
          onClick={() => void cargar()}
          disabled={cargando}
          className="rounded-lg border border-[var(--carta-border)] px-3 py-1.5 text-xs font-medium text-navy hover:bg-[var(--carta-fill)] disabled:opacity-40"
        >
          {cargando ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </p>
      )}
      {cargando && !datos && !error && (
        <p className="mt-2 text-xs text-teal/70">Consultando el CRM -- las trece zonas pueden tardar unos segundos…</p>
      )}

      {datos && (
        <>
          {/* Hallazgo de producción (2026-09-10): si una zona no se pudo
              calcular, los totales de abajo son un PISO -- nunca la cifra
              completa (la zona en error podría sumar más). Nunca se
              muestra un total que finja estar completo cuando falta una
              zona -- este aviso es la forma de decirlo. */}
          {datos.totalIncompleto && (
            <p role="alert" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              No se pudo calcular {datos.zonasConError.length === 1 ? 'la zona' : 'las zonas'}{' '}
              <strong>{datos.zonasConError.join(', ')}</strong> -- los números de abajo NO las incluyen, así que son un
              mínimo, no el total real.
            </p>
          )}
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg bg-[var(--carta-fill)] p-3">
              <p className="text-xs text-teal">Direcciones pendientes</p>
              <p className="mt-1 font-display text-lg text-navy">
                {datos.totalIncompleto ? '≥ ' : ''}
                {formatearNumero(datos.totales.pendientes)}
              </p>
              {/* "únicas" -- la misma dirección puede vivir en dos zonas del
                  CRM; este número ya está deduplicado, nunca es la suma de
                  las trece zonas por separado. */}
              <p className="text-[11px] text-teal/70">
                de {datos.totalIncompleto ? '≥ ' : ''}
                {formatearNumero(datos.totales.direcciones)} en total, únicas
              </p>
            </div>
            <div className="rounded-lg bg-[var(--carta-fill)] p-3">
              <p className="text-xs text-teal">Cupo de hoy</p>
              <p className="mt-1 font-display text-lg text-navy">
                {formatearNumero(datos.cupoHoy.disponible)} / {formatearNumero(datos.cupoHoy.tope)}
              </p>
              <p className="text-[11px] text-teal/70">
                {datos.cupoHoy.diaHabilHoy ? `día ${datos.cupoHoy.dia} de la rampa` : 'hoy no corre -- fin de semana'}
              </p>
            </div>
            <div className="rounded-lg bg-[var(--carta-fill)] p-3 sm:col-span-2">
              <p className="text-xs text-teal">Fecha estimada de término</p>
              <p className="mt-1 font-display text-lg text-navy">
                {datos.fechaEstimadaFin ? formatearFechaCorta(datos.fechaEstimadaFin) : 'Ya no queda nada pendiente'}
              </p>
              {/* El detalle honesto que pidió el encargo: no es una
                  promesa, es una proyección que asume que nada cambia. */}
              <p className="text-[11px] text-teal/70">
                Estimado -- asume que nadie pausa el envío ni cambia el cupo entre hoy y esa fecha.
                {datos.totalIncompleto ? ' Con zonas sin calcular, además podría atrasarse.' : ''}
              </p>
            </div>
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border border-[var(--carta-border)]">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-[var(--carta-fill)] text-xs uppercase tracking-wide text-teal">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Zona</th>
                  <th className="px-3 py-2">Estado</th>
                  <th className="px-3 py-2">Direcciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--carta-border)]">
                {datos.zonas.map((z) => (
                  <tr key={z.zona} className={z.estado === 'en_curso' ? 'bg-teal/5' : undefined}>
                    <td className="px-3 py-2 align-top text-teal">{z.orden}</td>
                    <td className="px-3 py-2 align-top text-navy">{z.zona}</td>
                    <td className="px-3 py-2 align-top">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          z.estado === 'terminada'
                            ? 'bg-emerald-50 text-emerald-800'
                            : z.estado === 'en_curso'
                              ? 'bg-teal/10 text-teal'
                              : z.estado === 'error'
                                ? 'bg-red-50 text-red-800'
                                : 'bg-[var(--carta-fill)] text-teal/70'
                        }`}
                      >
                        {ETIQUETAS_ESTADO_ZONA[z.estado]}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top text-teal">
                      {z.estado === 'error' ? (
                        <span className="text-red-800">{z.error ?? 'No se pudo consultar el CRM para esta zona.'}</span>
                      ) : z.estado === 'espera' ? (
                        <span>{formatearNumero(z.direccionesTotal)} por mandar</span>
                      ) : (
                        <span>
                          {formatearNumero(z.direccionesEnviadas)}/{formatearNumero(z.direccionesTotal)} enviadas
                          {z.direccionesFallidas > 0 ? `, ${formatearNumero(z.direccionesFallidas)} con error` : ''}
                          {z.direccionesPendientes > 0 ? ` -- quedan ${formatearNumero(z.direccionesPendientes)}` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

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
  // Hallazgo de producción (2026-09-10): armada por el cron del envío
  // programado, no a mano -- una campaña así que quedó con pendientes NO
  // está "interrumpida", está esperando su turno de cupo diario (la rampa
  // de calentamiento). Esta pantalla usa el campo para dos cosas: cambiar
  // el texto ("en cola", no "interrumpida") y, sobre todo, NO ofrecer
  // "Retomar" -- ese botón, para una campaña programada, mandaría de un
  // tirón lo que la rampa reparte en semanas, saltándose el cupo del día.
  // `/api/campanas/enviar` lo rechaza aunque alguien llame la ruta
  // directo (ver el comentario grande de esa ruta) -- esto es sólo la
  // primera línea de defensa, la que evita que nadie tenga que toparse con
  // ese rechazo en el uso normal.
  programada: boolean;
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

// El interruptor de apagado del envío programado (encargo, punto 6): "un
// interruptor para parar todo, sin necesidad de desplegar; que sea
// evidente en la pantalla si está parado". Vive arriba de todo en esta
// pestaña -- lo primero que se ve al abrir Historial de campañas -- porque
// es la pantalla que ya existe para controlar el envío en curso; separarlo
// en una pestaña propia lo escondería justo cuando más urge encontrarlo (a
// mitad de un problema, no en una exploración tranquila).
//
// Componente propio, con su propio `fetch` al montar: independiente del
// listado de campañas de abajo (`cargarCampanas`) -- una falla al leer el
// historial no debería tapar el estado del interruptor, ni viceversa.
function InterruptorProgramado({ obtenerCsrf, onSesionInvalida }: Props) {
  const [pausado, setPausado] = useState<boolean | null>(null);
  const [pausadoPor, setPausadoPor] = useState<string | null>(null);
  const [pausadoAt, setPausadoAt] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  const [cambiando, setCambiando] = useState(false);

  const cargarEstado = useCallback(async () => {
    setCargando(true);
    setError('');
    try {
      const res = await fetch('/api/campanas/programado', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        if (res.status === 401) return onSesionInvalida();
        setError(datos.error ?? `Error ${res.status}`);
        return;
      }
      setPausado(Boolean(datos.pausado));
      setPausadoPor(datos.pausadoPor ?? null);
      setPausadoAt(datos.pausadoAt ?? null);
    } catch {
      setError('Fallo de red al consultar el envío programado.');
    } finally {
      setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onSesionInvalida` es estable entre renders (viene de Panel).
  }, []);

  useEffect(() => {
    void cargarEstado();
  }, [cargarEstado]);

  async function alternar() {
    if (pausado === null) return;
    setCambiando(true);
    setError('');
    try {
      const csrf = obtenerCsrf();
      const res = await fetch('/api/campanas/programado/pausar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({ pausado: !pausado }),
      });
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        if (res.status === 401) {
          onSesionInvalida();
          return;
        }
        setError(datos.error ?? `Error ${res.status}`);
        return;
      }
      await cargarEstado();
    } catch {
      setError('Fallo de red al cambiar el envío programado.');
    } finally {
      setCambiando(false);
    }
  }

  return (
    <div
      className={`rounded-xl border p-4 ${
        pausado ? 'border-amber-300 bg-amber-50' : 'border-[var(--carta-border)] bg-white'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-sm text-navy">Envío programado</h2>
          {cargando && pausado === null && <p className="mt-1 text-xs text-teal/70">Consultando…</p>}
          {pausado === true && (
            <p className="mt-1 text-xs font-semibold text-amber-800" role="status">
              PAUSADO{pausadoPor ? ` por ${pausadoPor}` : ''}
              {pausadoAt ? ` el ${formatearFecha(pausadoAt)}` : ''} -- el cron de todos los días no va a mandar nada
              hasta que se reanude.
            </p>
          )}
          {pausado === false && (
            <p className="mt-1 text-xs text-teal" role="status">
              Activo -- el cron manda la zona que le toque de lunes a viernes, dentro del cupo diario.
            </p>
          )}
        </div>
        {pausado !== null && (
          <button
            type="button"
            onClick={() => void alternar()}
            disabled={cambiando}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-40 ${
              pausado
                ? 'bg-navy text-beige hover:bg-navy/90'
                : 'border-2 border-amber-600 bg-amber-50 text-amber-900 hover:bg-amber-100'
            }`}
          >
            {cambiando ? 'Actualizando…' : pausado ? 'Reanudar' : 'Pausar'}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </p>
      )}
    </div>
  );
}

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
      <InterruptorProgramado obtenerCsrf={obtenerCsrf} onSesionInvalida={onSesionInvalida} />

      <ColaProgramada onSesionInvalida={onSesionInvalida} />

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
                              : c.programada
                                /* Hallazgo de producción (2026-09-10): NO está
                                   interrumpida -- está esperando el cupo
                                   diario de la rampa. "Interrumpida" describe
                                   una falla que no ocurrió y asusta sin
                                   motivo; ver el comentario de `programada`
                                   en FilaCampana. */
                                ? `En cola del envío programado -- quedan ${progreso.pendientes}, sigue cuando le toque cupo.`
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
                          {/* Hallazgo de producción (2026-09-10): una campaña
                              `programada` NO ofrece "Retomar" -- mandaría de
                              un tirón lo que la rampa reparte en semanas,
                              saltándose el cupo del día. "Cancelar" se queda:
                              pararla tiene que seguir siendo posible. Ver el
                              comentario de `programada` en FilaCampana. */}
                          {!enviandoAhora && !c.programada && (
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
