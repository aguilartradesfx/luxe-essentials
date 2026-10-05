'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ETIQUETAS_PLANTILLA, formatearFecha, formatearNumero } from './formato';
import {
  AYUDA_ENTREGA,
  ESTADOS_ENTREGA,
  ETIQUETAS_ENTREGA,
  pastillaDeEntrega,
  type EstadoEntrega,
} from '@/lib/campanas/estado-entrega';

// La pestaña «Correos enviados»: los envíos de las campañas UNO POR UNO,
// con en qué quedó cada uno (pedido del dueño: «poder ver todos los emails
// uno a uno, y poder filtrarlos»). Es el complemento del historial de
// campañas, que cuenta campañas; acá se ve cada correo.
//
// Tres decisiones que no se negocian en esta pantalla:
//
//   1. Nunca dice que un correo «cayó en spam». Resend no lo sabe y nadie lo
//      sabe. «Lo marcó como spam» es otra cosa: la persona lo recibió y lo
//      reportó (ver lib/campanas/estado-entrega.ts).
//   2. Filtros, búsqueda y paginado son del SERVIDOR. Filtrar acá sobre una
//      página sería un filtro que miente: mostraría «no hay rebotados»
//      porque no hay en ESTA página.
//   3. «Sin confirmar» no es «falló»: es un correo que salió y del que
//      todavía no llegó ningún aviso de entrega. Tiene su propio color, y la
//      pantalla dice por qué puede estar así.
//
// Autorización: la ruta relee la fila de quien pide
// (`autorizarSuperadmin`); este componente no agrega protección propia.

type Envio = {
  id: string;
  correo: string;
  empresa: string;
  zona: string | null;
  plantilla: string;
  campanaId: string;
  enviadoAt: string;
  estado: EstadoEntrega;
  detalle: string | null;
};
type Cursor = { at: string; id: string };
type OpcionCampana = { id: string; zona: string | null; plantilla: string; creadoAt: string };
type Pagina = {
  envios: Envio[];
  tamano: number;
  total: number;
  siguiente: Cursor | null;
  opciones: { zonas: string[]; campanas: OpcionCampana[] };
  hayConfirmaciones: boolean;
};

type Props = { onSesionInvalida: () => void };

const ESPERA_BUSQUEDA_MS = 350;
// Estos estados traen un motivo de Resend que vale la pena ver sin abrir nada.
const ESTADOS_CON_MOTIVO: EstadoEntrega[] = ['retrasado', 'rebotado', 'fallido', 'no_salio'];

const CLASE_CAMPO = 'rounded-lg border border-[var(--carta-border)] bg-white px-2 py-1.5 text-sm text-navy';

function etiquetaCampana(c: OpcionCampana): string {
  return `${ETIQUETAS_PLANTILLA[c.plantilla] ?? c.plantilla} · ${c.zona ?? 'sin zona'} · ${formatearFecha(c.creadoAt).slice(0, 10)}`;
}

export function VistaEnviosCampanas({ onSesionInvalida }: Props) {
  const [zona, setZona] = useState('');
  const [campanaId, setCampanaId] = useState('');
  const [estado, setEstado] = useState<EstadoEntrega | ''>('');
  const [textoBusqueda, setTextoBusqueda] = useState('');
  const [busqueda, setBusqueda] = useState('');
  // Los cursores de las páginas ya visitadas; `[null]` es la primera.
  // «Anterior» saca uno, «Siguiente» agrega el que trajo el servidor.
  const [pila, setPila] = useState<(Cursor | null)[]>([null]);
  const [pagina, setPagina] = useState<Pagina | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  // Sólo vale la última petición: si el usuario cambia un filtro con otra
  // respuesta en camino, la vieja no puede pisar la nueva (mostraría
  // resultados de un filtro que ya no está puesto).
  const ultimaPeticion = useRef(0);

  // La búsqueda espera a que se deje de escribir. Cambiarla vuelve a la
  // primera página (un cursor de la búsqueda anterior no sirve para ésta).
  const busquedaAplicada = useRef('');
  useEffect(() => {
    const t = setTimeout(() => {
      const nueva = textoBusqueda.trim();
      if (nueva === busquedaAplicada.current) return;
      busquedaAplicada.current = nueva;
      setBusqueda(nueva);
      setPila([null]);
    }, ESPERA_BUSQUEDA_MS);
    return () => clearTimeout(t);
  }, [textoBusqueda]);

  const cursorActual = pila[pila.length - 1];

  const cargar = useCallback(async () => {
    const numero = ++ultimaPeticion.current;
    setCargando(true);
    setError('');
    try {
      const res = await fetch('/api/campanas/envios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          zona: zona || undefined,
          campanaId: campanaId || undefined,
          estado: estado || undefined,
          busqueda: busqueda || undefined,
          despues: cursorActual ?? undefined,
        }),
      });
      const datos = await res.json();
      if (numero !== ultimaPeticion.current) return;
      if (!res.ok || !datos.ok) {
        if (res.status === 401) return onSesionInvalida();
        setError(datos.error ?? `Error ${res.status}`);
        return;
      }
      setPagina(datos as Pagina);
    } catch {
      if (numero === ultimaPeticion.current) setError('Fallo de red al consultar los correos enviados.');
    } finally {
      if (numero === ultimaPeticion.current) setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onSesionInvalida` es estable entre renders (viene de Panel).
  }, [zona, campanaId, estado, busqueda, cursorActual]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  function cambiarFiltro(poner: () => void) {
    poner();
    setPila([null]);
  }

  const campanasVisibles = (pagina?.opciones.campanas ?? []).filter((c) => !zona || c.zona === zona);
  const hayFiltros = Boolean(zona || campanaId || estado || busqueda);
  const desde = pagina && pagina.envios.length > 0 ? (pila.length - 1) * pagina.tamano + 1 : 0;
  const hasta = pagina ? desde + pagina.envios.length - (pagina.envios.length > 0 ? 1 : 0) : 0;

  function limpiar() {
    setZona('');
    setCampanaId('');
    setEstado('');
    setTextoBusqueda('');
    busquedaAplicada.current = '';
    setBusqueda('');
    setPila([null]);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-sm text-navy">Correos enviados</h2>
        <button
          type="button"
          onClick={() => void cargar()}
          disabled={cargando}
          className="rounded-lg border border-[var(--carta-border)] px-3 py-1.5 text-xs font-medium text-navy hover:bg-[var(--carta-fill)] disabled:opacity-40"
        >
          {cargando ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-teal">
          Zona
          <select
            aria-label="Zona"
            value={zona}
            onChange={(e) =>
              cambiarFiltro(() => {
                const nueva = e.target.value;
                setZona(nueva);
                // Una campaña de otra zona no puede quedar elegida.
                const elegida = pagina?.opciones.campanas.find((c) => c.id === campanaId);
                if (nueva && elegida && elegida.zona !== nueva) setCampanaId('');
              })
            }
            className={CLASE_CAMPO}
          >
            <option value="">Todas</option>
            {(pagina?.opciones.zonas ?? []).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-teal">
          Campaña
          <select
            aria-label="Campaña"
            value={campanaId}
            onChange={(e) => cambiarFiltro(() => setCampanaId(e.target.value))}
            className={CLASE_CAMPO}
          >
            <option value="">Todas</option>
            {campanasVisibles.map((c) => (
              <option key={c.id} value={c.id}>
                {etiquetaCampana(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-teal">
          Estado
          <select
            aria-label="Estado"
            value={estado}
            onChange={(e) => cambiarFiltro(() => setEstado(e.target.value as EstadoEntrega | ''))}
            className={CLASE_CAMPO}
          >
            <option value="">Todos</option>
            {ESTADOS_ENTREGA.map((e) => (
              <option key={e} value={e}>
                {ETIQUETAS_ENTREGA[e]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-teal">
          Buscar
          <input
            type="search"
            aria-label="Buscar por correo o empresa"
            placeholder="Correo o empresa"
            value={textoBusqueda}
            onChange={(e) => setTextoBusqueda(e.target.value)}
            className={CLASE_CAMPO}
          />
        </label>
        {hayFiltros && (
          <button
            type="button"
            onClick={limpiar}
            className="rounded-lg border border-[var(--carta-border)] px-3 py-1.5 text-xs font-medium text-navy hover:bg-[var(--carta-fill)]"
          >
            Limpiar
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </p>
      )}

      {/* Sin ninguna confirmación en toda la base, «todo sin confirmar» casi
          seguro es el webhook sin configurar -- no un problema de los
          correos. Se dice acá, una vez, en vez de dejar creer que fallaron. */}
      {pagina && !pagina.hayConfirmaciones && (pagina.total > 0 || hayFiltros) && (
        <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Todavía no llegó ninguna confirmación de entrega desde Resend. Puede ser que el webhook no esté
          configurado: «Sin confirmar» no quiere decir que los correos hayan fallado.
        </p>
      )}

      <details className="rounded-xl border border-[var(--carta-border)] bg-white px-4 py-2 text-xs text-teal">
        <summary className="cursor-pointer font-medium text-navy">Qué significa cada estado</summary>
        <p className="mt-2">
          Resend no informa si un correo cayó en la carpeta de spam, y nadie más puede saberlo. Esta pantalla no lo
          muestra.
        </p>
        <dl className="mt-2 space-y-1.5">
          {ESTADOS_ENTREGA.map((e) => (
            <div key={e}>
              <dt className="inline font-medium text-navy">{ETIQUETAS_ENTREGA[e]}: </dt>
              <dd className="inline">{AYUDA_ENTREGA[e]}</dd>
            </div>
          ))}
        </dl>
      </details>

      {pagina && pagina.envios.length === 0 && !cargando && !error && (
        <p className="text-xs text-teal/70">
          {hayFiltros ? 'Ningún correo coincide con estos filtros.' : 'Todavía no salió ningún correo.'}
        </p>
      )}

      {pagina && pagina.envios.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-[var(--carta-border)]">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-[var(--carta-fill)] text-xs uppercase tracking-wide text-teal">
              <tr>
                <th className="px-3 py-2">Destinatario</th>
                <th className="px-3 py-2">Zona y campaña</th>
                <th className="px-3 py-2">Enviado</th>
                <th className="px-3 py-2">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--carta-border)]">
              {pagina.envios.map((e) => {
                const pastilla = pastillaDeEntrega(e.estado);
                return (
                  <tr key={e.id}>
                    <td className="px-3 py-2 align-top">
                      <p className="break-all font-medium text-navy">{e.correo}</p>
                      <p className="mt-0.5 text-xs text-teal">{e.empresa}</p>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <p className="text-navy">{e.zona ?? '—'}</p>
                      <p className="mt-0.5 text-xs text-teal">{ETIQUETAS_PLANTILLA[e.plantilla] ?? e.plantilla}</p>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top text-xs text-teal">
                      {formatearFecha(e.enviadoAt)}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <span
                        title={AYUDA_ENTREGA[e.estado]}
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${pastilla.clase}`}
                      >
                        {pastilla.texto}
                      </span>
                      {e.detalle && ESTADOS_CON_MOTIVO.includes(e.estado) && (
                        <p className="mt-1 max-w-xs text-xs text-teal/70" title={e.detalle}>
                          {e.detalle}
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pagina && pagina.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-teal">
          <span className="tabular-nums">
            {formatearNumero(desde)}–{formatearNumero(hasta)} de {formatearNumero(pagina.total)}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPila((p) => p.slice(0, -1))}
              disabled={pila.length <= 1 || cargando}
              className="rounded-lg border border-[var(--carta-border)] px-3 py-1.5 font-medium text-navy hover:bg-[var(--carta-fill)] disabled:opacity-40"
            >
              Anterior
            </button>
            <button
              type="button"
              onClick={() => pagina.siguiente && setPila((p) => [...p, pagina.siguiente])}
              disabled={!pagina.siguiente || cargando}
              className="rounded-lg border border-[var(--carta-border)] px-3 py-1.5 font-medium text-navy hover:bg-[var(--carta-fill)] disabled:opacity-40"
            >
              Siguiente
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
