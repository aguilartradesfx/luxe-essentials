'use client';

import { useEffect, useState } from 'react';
import { formatearColones, formatearTasa } from './formato';

// Tarea 11: la pestaña "Métricas" del panel. Seis bloques fijos, cada uno
// elegido con un solo criterio (ver "Las métricas" en
// docs/superpowers/specs/2026-08-27-panel-cotizaciones-design.md): el
// número tiene que decirle a alguien qué hacer hoy. Lo que solo informa no
// entró -- por eso no hay ticket promedio, ni gráficos: seis puntos no son
// una serie, son decoración.
//
// No importa `lib/cotizador/metricas.ts` (lleva `import 'server-only'`,
// igual que `catalogo.ts`/`escalas.ts`/`calcular.ts`): define su propia
// forma local más abajo, igual que hace `VistaListado.tsx` con
// `FilaListado`. Todos los números ya vienen calculados por el servidor —
// esta vista solo los pinta, en la respuesta de `POST
// /api/cotizacion/metricas` (ruta de lectura, sin token anti-CSRF).

// Ronda de correcciones 1: "ganado" y "perdido" pasaron a acotarse al mes
// calendario en `lib/cotizador/metricas.ts` (`calcularMetricas`), con el
// mes anterior como línea base de comparación -- un acumulado sin fecha no
// tiene con qué compararse, y "ganamos ₡3,6 millones" no le dice a nadie si
// eso es bueno o malo.
type ResumenMes = { cantidad: number; monto: number; diasPromedio: number };

type Metricas = {
  sinRespuesta: { cantidad: number; monto: number; porVencer: number; vencidas: number };
  ganado: { mesActual: ResumenMes; mesAnterior: ResumenMes };
  perdido: { mesActual: ResumenMes; mesAnterior: ResumenMes };
  descuento: { monto: number; promedioPct: number };
  productos: Array<{ nombre: string; unidades: number; monto: number }>;
  porLinea: { uniformes: { monto: number }; hogar: { monto: number } };
  porOrigen: Record<string, number>;
  fallidas: number;
};

// Concordancia de número: "1 vence" / "2 vencen", no "1 vencen". Sin esto el
// caso más común -- una sola cotización por vencer -- lee mal justo en el
// bloque más accionable de los seis.
function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}

// La diferencia contra el mes anterior, con signo: "+₡500.000" si se ganó
// más que el mes pasado, "-₡200.000" si se ganó menos. Es la respuesta a
// "¿esto es bueno o malo?", que un monto suelto no contesta por sí solo.
function formatearDiferencia(actual: number, anterior: number): string {
  const delta = actual - anterior;
  if (delta === 0) return 'igual que el mes pasado';
  const signo = delta > 0 ? '+' : '-';
  return `${signo}${formatearColones(Math.abs(delta))} vs. el mes pasado`;
}

// Cuántos productos listar en "Qué se cotiza": los primeros bastan para
// leerse de un vistazo -- una lista de veinte deja de serlo.
const TOP_PRODUCTOS = 5;

type Props = {
  // Mismo mecanismo que ya tiene Panel para un 401 a mitad de trabajo: no
  // se inventa uno nuevo acá.
  onSesionInvalida: () => void;
  // El único bloque con acción (Fallidas): hoy esas cotizaciones son
  // invisibles para todo el mundo, y este es el único camino que las saca a
  // la luz. Quien decide qué hacer con el pedido -- cambiar de pestaña,
  // aplicar el filtro -- es `Panel`, no esta vista.
  onVerFallidas: () => void;
};

export function VistaMetricas({ onSesionInvalida, onVerFallidas }: Props) {
  const [metricas, setMetricas] = useState<Metricas | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelado = false;
    async function cargar() {
      setCargando(true);
      setError('');
      try {
        const res = await fetch('/api/cotizacion/metricas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const datos = await res.json();
        if (cancelado) return;
        if (!res.ok || !datos.ok) {
          if (res.status === 401) {
            onSesionInvalida();
            return;
          }
          setError(datos.error ?? `Error ${res.status}`);
          return;
        }
        setMetricas(datos.metricas as Metricas);
      } catch {
        if (!cancelado) setError('Fallo de red.');
      } finally {
        if (!cancelado) setCargando(false);
      }
    }
    void cargar();
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- se carga una sola vez, al montar (esta pestaña se remonta entera cada vez que se entra a ella).
  }, []);

  if (cargando) return <p className="text-sm text-teal">Cargando…</p>;
  if (error) return <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>;
  if (!metricas) return null;

  const { sinRespuesta, ganado, perdido, descuento, productos, porLinea, porOrigen, fallidas } = metricas;
  const totalLinea = porLinea.uniformes.monto + porLinea.hogar.monto;
  const pctUniformes = totalLinea > 0 ? Math.round((porLinea.uniformes.monto / totalLinea) * 100) : 0;
  const pctHogar = totalLinea > 0 ? 100 - pctUniformes : 0;
  const deAgente = porOrigen.agente ?? 0;
  const deVendedor = porOrigen.humano ?? 0;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {/* 1. Cotizado sin respuesta: a quién llamar hoy. */}
      <section className="rounded-xl border border-[var(--carta-border)] p-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-teal">Cotizado, sin respuesta</h2>
        <p className="mt-1 font-display text-2xl text-navy">{formatearColones(sinRespuesta.monto)}</p>
        <p className="mt-1 text-xs text-teal">
          Cotizaciones sin respuesta todavía: {sinRespuesta.cantidad}. {sinRespuesta.porVencer}{' '}
          {plural(sinRespuesta.porVencer, 'vence', 'vencen')} esta semana — a esas llamá primero.
          {sinRespuesta.vencidas > 0 &&
            ` ${sinRespuesta.vencidas} ya ${plural(sinRespuesta.vencidas, 'venció', 'vencieron')}: a esas no se les llama, se les vuelve a cotizar.`}
        </p>
      </section>

      {/* 2. Ganado y perdido: cuánto se cerró este mes contra el anterior. */}
      <section className="rounded-xl border border-[var(--carta-border)] p-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-teal">Ganado y perdido</h2>
        <div className="mt-1 flex gap-6">
          <div>
            <p className="font-display text-2xl text-navy">{formatearColones(ganado.mesActual.monto)}</p>
            <p className="text-xs text-teal">
              Ganado este mes — {ganado.mesActual.cantidad} cotizaciones, {ganado.mesActual.diasPromedio} día(s) en
              promedio hasta cerrarse. Mes pasado: {formatearColones(ganado.mesAnterior.monto)} (
              {formatearDiferencia(ganado.mesActual.monto, ganado.mesAnterior.monto)}).
            </p>
          </div>
          <div>
            <p className="font-display text-2xl text-navy">{formatearColones(perdido.mesActual.monto)}</p>
            <p className="text-xs text-teal">
              Perdido este mes — {perdido.mesActual.cantidad} cotizaciones, {perdido.mesActual.diasPromedio} día(s)
              en promedio hasta cerrarse. Mes pasado: {formatearColones(perdido.mesAnterior.monto)} (
              {formatearDiferencia(perdido.mesActual.monto, perdido.mesAnterior.monto)}).
            </p>
          </div>
        </div>
      </section>

      {/* 3. Descuento otorgado: si el promedio sube, el margen se erosiona. */}
      <section className="rounded-xl border border-[var(--carta-border)] p-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-teal">Descuento otorgado</h2>
        <p className="mt-1 font-display text-2xl text-navy">{formatearColones(descuento.monto)}</p>
        <p className="mt-1 text-xs text-teal">
          Promedio {formatearTasa(descuento.promedioPct / 100)}% del precio de lista, entregado a los clientes.
        </p>
      </section>

      {/* 4. Qué se cotiza: productos más pedidos y reparto uniformes/hogar. */}
      <section className="rounded-xl border border-[var(--carta-border)] p-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-teal">Qué se cotiza</h2>
        {productos.length === 0 ? (
          <p className="mt-1 text-xs text-teal">Todavía no hay productos cotizados.</p>
        ) : (
          <ol className="mt-1 space-y-0.5 text-sm text-navy">
            {productos.slice(0, TOP_PRODUCTOS).map((p) => (
              <li key={p.nombre} className="flex justify-between gap-2">
                <span>{p.nombre}</span>
                <span className="text-teal">{p.unidades} u.</span>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-2 text-xs text-teal">
          Uniformes {formatearColones(porLinea.uniformes.monto)} ({pctUniformes}%) · Hogar{' '}
          {formatearColones(porLinea.hogar.monto)} ({pctHogar}%) — para producción, no solo para ventas.
        </p>
      </section>

      {/* 5. Fallidas: el único bloque con acción. */}
      <section className="rounded-xl border border-[var(--carta-border)] p-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-teal">Fallidas</h2>
        <p className="mt-1 font-display text-2xl text-navy">{fallidas}</p>
        <p className="mt-1 text-xs text-teal">
          No llegaron al cliente por un error técnico. Hoy son invisibles para todos menos acá.
        </p>
        <button
          type="button"
          onClick={onVerFallidas}
          className="mt-2 rounded-lg border border-[var(--carta-border)] px-2 py-1 text-xs font-medium text-navy hover:bg-navy hover:text-beige"
        >
          Ver en el listado
        </button>
      </section>

      {/* 6. Origen: si el agente aporta cotizaciones reales o solo conversaciones. */}
      <section className="rounded-xl border border-[var(--carta-border)] p-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-teal">Origen</h2>
        <p className="mt-1 font-display text-2xl text-navy">{deAgente}</p>
        <p className="mt-1 text-xs text-teal">
          Nacieron del agente de WhatsApp, contra {deVendedor} que armó un vendedor a mano.
        </p>
      </section>
    </div>
  );
}
