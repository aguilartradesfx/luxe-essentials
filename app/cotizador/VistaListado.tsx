'use client';

import { useEffect, useMemo, useState } from 'react';
import type { LineaEntrada } from '@/lib/cotizador/tipos';
import type { PrefillCotizacion } from './Panel';
import { formatearColones } from './formato';

// Tarea 10: la pestaña "Cotizaciones". Es la razón por la que se decidió
// construir un panel en vez de seguir con el CRM: acá es donde el vendedor
// ve lo que cotizó y actúa —marca ganada/perdida, reenvía, duplica, salta
// al contacto en GoHighLevel—. No importa `catalogo.ts`, `escalas.ts` ni
// `calcular.ts`: todo lo que se muestra viene calculado del servidor, en la
// respuesta de `/api/cotizacion/listado`.

// Mismos estados que puede tener una fila (ver app/api/cotizacion/cerrar/route.ts
// y app/api/cotizacion/route.ts): 'borrador'/'convertida' son del flujo del
// agente y rara vez aparecen acá, pero el tipo los contempla para no
// reventar si alguno se cuela.
type Estado = 'borrador' | 'creada' | 'enviada' | 'convertida' | 'ganada' | 'perdida' | 'error';

// Igual que en VistaCrear.tsx: el jsonb `cliente`/`totales` no tiene forma
// garantizada por TypeScript (viaja como `unknown` desde la base), así que
// se lee campo por campo en vez de confiar en el tipo.
type ClienteFila = Record<string, unknown>;
type TotalesFila = Record<string, unknown>;

type FilaListado = {
  id: string;
  numero: string | null;
  created_at: string;
  updated_at: string;
  estado: Estado;
  origen: string;
  contact_id: string | null;
  cliente: ClienteFila;
  totales: TotalesFila;
  enviado_at: string | null;
  cerrada_at: string | null;
  pdf_ruta: string | null;
  motivo_cierre: string | null;
  ghl_estimate_id: string | null;
  ghl_error: string | null;
};

type Mensaje = { tipo: 'ok' | 'aviso' | 'error'; texto: string };

// Mismo criterio que `textoDe` en VistaCrear.tsx: el jsonb no garantiza que
// un campo exista o sea del tipo esperado, así que cualquier otra cosa se
// trata como ausente en vez de reventar la pantalla.
function textoDe(valor: unknown): string {
  return typeof valor === 'string' ? valor : '';
}

function numeroDe(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : 0;
}

// Mismo helper que `conClave` en VistaCrear.tsx, duplicado a propósito
// (misma nota: esta pantalla es de cliente, no puede importar código del
// servidor). `clave` vacía significa "la sesión por cookie ya alcanza" — no
// hay credencial que mandar de más.
function conClave(clave: string, resto: Record<string, unknown>): Record<string, unknown> {
  return clave ? { clave, ...resto } : resto;
}

function formatearFecha(iso: string): string {
  const f = new Date(iso);
  if (Number.isNaN(f.getTime())) return iso;
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${dos(f.getDate())}/${dos(f.getMonth() + 1)}/${f.getFullYear()}`;
}

// Mismo valor que `DIAS_VIGENCIA` en app/api/cotizacion/reenviar/route.ts:
// cuántos días queda vigente el precio cotizado, contados desde
// `created_at`. Duplicado por la misma razón de siempre — esta pantalla no
// puede importar código del servidor.
const DIAS_VIGENCIA = 30;
// A partir de cuántos días de margen el vencimiento se considera "pronto".
const DIAS_AVISO_VENCIMIENTO = 7;
// Solo una cotización sin respuesta todavía puede "vencer": una ya cerrada
// (ganada/perdida) o convertida no necesita que nadie la llame por eso.
const ESTADOS_ABIERTOS: Estado[] = ['creada', 'enviada', 'error'];

type Vigencia = { vence: Date; diasRestantes: number; proximaAVencer: boolean };

function calcularVigencia(fila: FilaListado, ahora: Date): Vigencia {
  const vence = new Date(fila.created_at);
  vence.setDate(vence.getDate() + DIAS_VIGENCIA);
  const diasRestantes = Math.ceil((vence.getTime() - ahora.getTime()) / (24 * 60 * 60 * 1000));
  const proximaAVencer = ESTADOS_ABIERTOS.includes(fila.estado) && diasRestantes <= DIAS_AVISO_VENCIMIENTO;
  return { vence, diasRestantes, proximaAVencer };
}

const ETIQUETAS_ESTADO: Record<Estado, string> = {
  borrador: 'Borrador',
  creada: 'Creada',
  enviada: 'Enviada',
  convertida: 'Convertida',
  ganada: 'Ganada',
  perdida: 'Perdida',
  error: 'Error',
};

// Colores por estado (Paso 3 del brief): sin respuesta en neutro, ganada en
// verde, perdida en gris, error en rojo. El resto (borrador/convertida, que
// casi nunca aparecen acá) cae en el mismo neutro que "sin respuesta".
function estiloEstado(estado: Estado): string {
  switch (estado) {
    case 'ganada':
      return 'bg-emerald-100 text-emerald-800';
    case 'perdida':
      return 'bg-gray-200 text-gray-700';
    case 'error':
      return 'bg-red-100 text-red-800';
    default:
      return 'bg-[color:var(--carta-border)]/50 text-navy';
  }
}

// Ronda de correcciones 1 (hallazgo): "Por vencer" no es un estado que el
// servidor entienda -- es un cruce de "sin respuesta" + "vence pronto" que
// solo esta pantalla puede calcular (ver `calcularVigencia`). Con la lista
// llena (hasta 200 filas, ordenadas por fecha) una fila ambar en la
// posicion 40 deja de saltar a la vista con solo el resaltado -- que es
// justo lo que esta pantalla necesita para servir de algo. El valor no se
// manda como `estado` a `/listado` (ver `cargar`): se filtra del lado del
// cliente, sobre lo que ya bajo.
const FILTRO_POR_VENCER = 'por-vencer';

const OPCIONES_FILTRO: { valor: string; etiqueta: string }[] = [
  { valor: '', etiqueta: 'Todos' },
  { valor: FILTRO_POR_VENCER, etiqueta: 'Por vencer' },
  { valor: 'creada', etiqueta: 'Creada' },
  { valor: 'enviada', etiqueta: 'Enviada' },
  { valor: 'error', etiqueta: 'Error' },
  { valor: 'ganada', etiqueta: 'Ganada' },
  { valor: 'perdida', etiqueta: 'Perdida' },
];

type Props = {
  // La clave escrita al entrar por formulario; vacía cuando la sesión ya
  // estaba viva por cookie (ver Panel.tsx y VistaCrear.tsx).
  clave: string;
  // Token anti-CSRF vigente, para las dos acciones que escriben (cerrar,
  // reenviar). Mismo mecanismo que usa VistaCrear.
  obtenerCsrf: () => string | null;
  // Mismo mecanismo que ya tiene Panel para un 401 a mitad de trabajo: no
  // se inventa uno nuevo acá.
  onSesionInvalida: () => void;
  // "Duplicar": esta vista arma el cliente y pide las líneas al servidor
  // (sin precios, ver app/api/cotizacion/duplicar/route.ts); quien decide
  // qué hacer con eso —cambiar de pestaña, precargar el formulario— es
  // `Panel`, no esta vista.
  onDuplicar: (datos: PrefillCotizacion) => void;
};

export function VistaListado({ clave, obtenerCsrf, onSesionInvalida, onDuplicar }: Props) {
  const [cotizaciones, setCotizaciones] = useState<FilaListado[] | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  const [filtroEstado, setFiltroEstado] = useState('');
  // El enlace a GoHighLevel se arma con esto. Llega en la MISMA respuesta
  // de `/api/cotizacion/listado` (ver su comentario en el route.ts):
  // nunca desde `process.env.NEXT_PUBLIC_*` ni desde el catálogo — un env
  // var público quedaría embebido en el bundle de cliente para siempre,
  // aunque Luxe cambiara de cuenta de GoHighLevel.
  const [locationId, setLocationId] = useState('');

  // Fila en la que se está por confirmar "Perdida": el motivo se pide antes
  // de mandar nada al servidor (Paso 1 del brief).
  const [pidiendoMotivoId, setPidiendoMotivoId] = useState<string | null>(null);
  const [motivoTexto, setMotivoTexto] = useState('');

  // Una fila a la vez: es una herramienta de uso diario de un equipo chico,
  // no hace falta soportar acciones simultáneas en varias filas.
  const [procesandoId, setProcesandoId] = useState<string | null>(null);
  const [mensajesFila, setMensajesFila] = useState<Record<string, Mensaje>>({});

  // `estaCancelado`: solo lo usa el efecto de abajo, para que una respuesta
  // que llega tarde (el vendedor cambió el filtro dos veces seguido) no
  // pise el resultado de una consulta más nueva con uno viejo. Las otras
  // llamadas a `cargar` (después de cerrar/reenviar) son de una acción
  // puntual del vendedor, no de un filtro que puede cambiar de nuevo antes
  // de que la respuesta vuelva — no necesitan el mismo resguardo.
  async function cargar(estado: string, estaCancelado: () => boolean = () => false) {
    setCargando(true);
    setError('');
    // "Por vencer" no es un estado real: se pide la lista completa (o
    // filtrada por lo que sí entiende el servidor) y se recorta del lado
    // del cliente, más abajo, en `filasVisibles`.
    const estadoParaServidor = estado === FILTRO_POR_VENCER ? '' : estado;
    try {
      const res = await fetch('/api/cotizacion/listado', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conClave(clave, estadoParaServidor ? { estado: estadoParaServidor } : {})),
      });
      const datos = await res.json();
      if (estaCancelado()) return;
      if (!res.ok || !datos.ok) {
        if (res.status === 401) onSesionInvalida();
        setError(datos.error ?? `Error ${res.status}`);
        setCotizaciones([]);
        return;
      }
      setCotizaciones((datos.cotizaciones ?? []) as FilaListado[]);
      if (typeof datos.locationId === 'string') setLocationId(datos.locationId);
    } catch {
      if (!estaCancelado()) {
        setError('Fallo de red.');
        setCotizaciones([]);
      }
    } finally {
      if (!estaCancelado()) setCargando(false);
    }
  }

  useEffect(() => {
    let cancelado = false;
    // Ronda de correcciones 1 (hallazgo menor): un mensaje de error o de
    // "Reenviado." de una acción anterior no debe sobrevivir a un cambio de
    // filtro -- ni la fila a la que pertenecía sigue necesariamente visible
    // acá. Las llamadas a `cargar` que SÍ deben conservar el mensaje que
    // acaban de dejar (después de cerrar/reenviar/duplicar con éxito o
    // error) no pasan por este efecto, así que no las toca.
    setMensajesFila({});
    void cargar(filtroEstado, () => cancelado);
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- se pide de nuevo cada vez que cambia el filtro, no en cada render.
  }, [filtroEstado]);

  async function cerrar(id: string, estado: 'ganada' | 'perdida', motivo?: string) {
    setProcesandoId(id);
    try {
      const csrf = obtenerCsrf();
      const res = await fetch('/api/cotizacion/cerrar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Regla de seguridad 1: /cerrar escribe, exige el token anti-CSRF.
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({ id, estado, ...(motivo ? { motivo } : {}) }),
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
      setPidiendoMotivoId(null);
      setMotivoTexto('');
      await cargar(filtroEstado);
    } catch {
      setMensajesFila((m) => ({ ...m, [id]: { tipo: 'error', texto: 'Fallo de red.' } }));
    } finally {
      setProcesandoId(null);
    }
  }

  async function reenviar(id: string) {
    setProcesandoId(id);
    try {
      const csrf = obtenerCsrf();
      const res = await fetch('/api/cotizacion/reenviar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Regla de seguridad 1: /reenviar también escribe.
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({ id }),
      });
      const datos = await res.json();
      // OJO — contrato de /reenviar (task-8-report.md): `res.ok` NO
      // significa "sin nada que avisar". Puede volver 200 con
      // `actualizado: false` y `avisoActualizacion` cuando el correo salió
      // pero el registro no se pudo actualizar — hay que leer esos campos
      // aparte de `res.ok`, no asumir que 200 es "todo perfecto".
      if (!res.ok || !datos.ok) {
        if (res.status === 401) {
          onSesionInvalida();
          return;
        }
        setMensajesFila((m) => ({ ...m, [id]: { tipo: 'error', texto: datos.error ?? `Error ${res.status}` } }));
        return;
      }
      const partes = ['Reenviado.'];
      if (datos.vencida) partes.push('El precio ya venció: mejor duplicar y cotizar de nuevo.');
      if (datos.actualizado === false && typeof datos.avisoActualizacion === 'string') {
        partes.push(datos.avisoActualizacion);
      }
      const conAviso = datos.vencida || datos.actualizado === false;
      setMensajesFila((m) => ({ ...m, [id]: { tipo: conAviso ? 'aviso' : 'ok', texto: partes.join(' ') } }));
      // Si el registro sí quedó al día, refleja el nuevo estado (una fila
      // en 'error' puede haber sanado a 'enviada'). Si no se pudo
      // actualizar, refrescar ahora solo mostraría el mismo dato viejo.
      if (datos.actualizado !== false) await cargar(filtroEstado);
    } catch {
      setMensajesFila((m) => ({ ...m, [id]: { tipo: 'error', texto: 'Fallo de red.' } }));
    } finally {
      setProcesandoId(null);
    }
  }

  async function duplicar(fila: FilaListado) {
    setProcesandoId(fila.id);
    try {
      const res = await fetch('/api/cotizacion/duplicar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conClave(clave, { id: fila.id })),
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
      const c = fila.cliente ?? {};
      onDuplicar({
        cliente: {
          nombre: textoDe(c.nombre),
          empresa: textoDe(c.empresa),
          email: textoDe(c.email),
          telefono: textoDe(c.telefono),
          direccion: textoDe(c.direccion),
        },
        lineas: (datos.lineas ?? []) as LineaEntrada[],
      });
    } catch {
      setMensajesFila((m) => ({ ...m, [fila.id]: { tipo: 'error', texto: 'Fallo de red.' } }));
    } finally {
      setProcesandoId(null);
    }
  }

  // Ronda de correcciones 1: "Por vencer" recorta y ordena del lado del
  // cliente (ver `cargar` y la nota de `FILTRO_POR_VENCER`) -- las más
  // urgentes primero, para que la fila que vence hoy no dependa de scrollear
  // hasta encontrarla entre las 200 que puede traer el servidor.
  const filasVisibles = useMemo(() => {
    if (!cotizaciones) return null;
    if (filtroEstado !== FILTRO_POR_VENCER) return cotizaciones;
    const ahora = new Date();
    return [...cotizaciones]
      .filter((f) => calcularVigencia(f, ahora).proximaAVencer)
      .sort((a, b) => calcularVigencia(a, ahora).diasRestantes - calcularVigencia(b, ahora).diasRestantes);
  }, [cotizaciones, filtroEstado]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs text-teal">
          Filtrar por estado
          <select
            aria-label="Filtrar por estado"
            value={filtroEstado}
            onChange={(e) => setFiltroEstado(e.target.value)}
            className="rounded-lg border border-[var(--carta-border)] bg-white px-2 py-1.5 text-sm text-navy"
          >
            {OPCIONES_FILTRO.map((o) => (
              <option key={o.valor} value={o.valor}>
                {o.etiqueta}
              </option>
            ))}
          </select>
        </label>
        {cargando && <span className="text-xs text-teal/70">Cargando…</span>}
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}

      {filasVisibles !== null && filasVisibles.length === 0 && !cargando && !error && (
        <p className="text-sm text-teal">No hay cotizaciones para este filtro.</p>
      )}

      {filasVisibles !== null && filasVisibles.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-[var(--carta-border)]">
          <table className="w-full min-w-[840px] text-left text-sm">
            <thead className="bg-[var(--carta-fill)] text-xs uppercase tracking-wide text-teal">
              <tr>
                <th className="px-3 py-2">Cliente</th>
                <th className="px-3 py-2">Número</th>
                <th className="px-3 py-2">Fecha</th>
                <th className="px-3 py-2">Vigencia</th>
                <th className="px-3 py-2 text-right">Monto</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--carta-border)]">
              {filasVisibles.map((fila) => {
                const { vence, diasRestantes, proximaAVencer } = calcularVigencia(fila, new Date());
                const nombre = textoDe(fila.cliente?.nombre) || 'Sin nombre';
                const empresa = textoDe(fila.cliente?.empresa);
                const monto = numeroDe(fila.totales?.total);
                const mensaje = mensajesFila[fila.id];
                const enProceso = procesandoId === fila.id;

                return (
                  <tr
                    key={fila.id}
                    className={proximaAVencer ? 'bg-amber-50' : undefined}
                  >
                    <td className="px-3 py-2 align-top">
                      <p className="text-navy">{nombre}</p>
                      {empresa && <p className="text-xs text-teal">{empresa}</p>}
                    </td>
                    <td className="px-3 py-2 align-top text-navy">{fila.numero ?? '—'}</td>
                    <td className="px-3 py-2 align-top text-teal">{formatearFecha(fila.created_at)}</td>
                    <td className="px-3 py-2 align-top">
                      {proximaAVencer ? (
                        <span
                          className={`font-semibold ${diasRestantes < 0 ? 'text-red-700' : 'text-amber-700'}`}
                        >
                          {diasRestantes < 0
                            ? `Vencida hace ${Math.abs(diasRestantes)} día(s)`
                            : diasRestantes === 0
                              ? 'Vence hoy'
                              : `Vence en ${diasRestantes} día(s)`}
                        </span>
                      ) : (
                        <span className="text-xs text-teal/80">{formatearFecha(vence.toISOString())}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top text-right font-medium text-navy">
                      {formatearColones(monto)}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${estiloEstado(fila.estado)}`}>
                        {ETIQUETAS_ESTADO[fila.estado] ?? fila.estado}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={enProceso}
                          onClick={() => void cerrar(fila.id, 'ganada')}
                          className="rounded-lg border border-[var(--carta-border)] px-2 py-1 text-xs font-medium text-navy hover:bg-navy hover:text-beige disabled:opacity-40"
                        >
                          Ganada
                        </button>
                        <button
                          type="button"
                          disabled={enProceso}
                          onClick={() => {
                            setPidiendoMotivoId(fila.id);
                            setMotivoTexto('');
                          }}
                          className="rounded-lg border border-[var(--carta-border)] px-2 py-1 text-xs font-medium text-navy hover:bg-navy hover:text-beige disabled:opacity-40"
                        >
                          Perdida
                        </button>
                        {fila.pdf_ruta && (
                          <button
                            type="button"
                            disabled={enProceso}
                            onClick={() => void reenviar(fila.id)}
                            className="rounded-lg border border-[var(--carta-border)] px-2 py-1 text-xs font-medium text-navy hover:bg-navy hover:text-beige disabled:opacity-40"
                          >
                            Reenviar
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={enProceso}
                          onClick={() => void duplicar(fila)}
                          className="rounded-lg border border-[var(--carta-border)] px-2 py-1 text-xs font-medium text-navy hover:bg-navy hover:text-beige disabled:opacity-40"
                        >
                          Duplicar
                        </button>
                        {fila.contact_id && locationId && (
                          <a
                            href={`https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${fila.contact_id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-teal underline hover:text-navy"
                          >
                            Ver en GoHighLevel
                          </a>
                        )}
                      </div>

                      {pidiendoMotivoId === fila.id && (
                        <div className="mt-2 flex flex-col gap-1.5 rounded-lg bg-[color:var(--carta-border)]/30 p-2">
                          <label className="text-xs text-teal">
                            Motivo de la pérdida
                            <input
                              aria-label="Motivo de la pérdida"
                              value={motivoTexto}
                              onChange={(e) => setMotivoTexto(e.target.value)}
                              className="mt-1 w-full rounded-lg border border-[var(--carta-border)] bg-white px-2 py-1 text-xs text-navy"
                              placeholder="¿Por qué se perdió?"
                            />
                          </label>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={motivoTexto.trim().length === 0 || enProceso}
                              onClick={() => void cerrar(fila.id, 'perdida', motivoTexto.trim())}
                              className="rounded-lg bg-navy px-2 py-1 text-xs font-medium text-beige disabled:opacity-40"
                            >
                              Confirmar
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setPidiendoMotivoId(null);
                                setMotivoTexto('');
                              }}
                              className="rounded-lg border border-[var(--carta-border)] px-2 py-1 text-xs text-navy"
                            >
                              Cancelar
                            </button>
                          </div>
                        </div>
                      )}

                      {mensaje && (
                        <p
                          className={`mt-2 text-xs ${
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
