'use client';

import { useMemo, useState } from 'react';
import { calcular } from '@/lib/cotizador/calcular';
import { CATALOGO, buscarSku } from '@/lib/cotizador/catalogo';
import { IVA_GENERAL } from '@/lib/cotizador/escalas';
import type { LineaEntrada } from '@/lib/cotizador/tipos';

type Cliente = { nombre: string; empresa: string; email: string };

// Una línea por SKU, tal como la ve el vendedor. `cantidadTexto` guarda
// exactamente lo que hay en el input: si se guardara ya como número, borrar
// el campo para escribir uno nuevo forzaría a mostrar "0" en vez de vacío.
type LineaUI = { skuId: string; cantidadTexto: string };

type Resultado =
  | { ok: true; id: string; ghlEstimateId?: string; ghlError?: string }
  | { ok: false; error: string };

const CLIENTE_VACIO: Cliente = { nombre: '', empresa: '', email: '' };

// Sin tildes ni mayúsculas, para que "sabana" encuentre "sábana".
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

// Colones sin decimales, agrupados de a tres. No se usa `toLocaleString`
// porque el separador de miles que trae el runtime de Node para `es-CR`
// varía entre versiones de ICU (a veces un espacio, no un punto), y el
// formato con punto es el que Luxe espera ver.
function colones(valor: number): string {
  return `₡${Math.round(valor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

export default function Cotizador() {
  const [clave, setClave] = useState('');
  const [cliente, setCliente] = useState<Cliente>(CLIENTE_VACIO);
  const [busqueda, setBusqueda] = useState('');
  const [lineas, setLineas] = useState<LineaUI[]>([]);
  const [tasaIva, setTasaIva] = useState(IVA_GENERAL);
  const [bordadoEspecial, setBordadoEspecial] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  const resultadosBusqueda = useMemo(() => {
    const q = normalizar(busqueda.trim());
    if (!q) return [];
    return CATALOGO.filter(
      (sku) => normalizar(sku.nombre).includes(q) || normalizar(sku.familia).includes(q),
    ).slice(0, 20);
  }, [busqueda]);

  // Solo las cantidades que `calcular` acepta: enteros positivos. Mientras el
  // vendedor borra el campo para escribir una cantidad nueva, esa línea
  // simplemente no entra al cálculo — no se le pasa un NaN al motor.
  const entradas: LineaEntrada[] = useMemo(
    () =>
      lineas
        .map((l) => ({ skuId: l.skuId, cantidad: Number.parseInt(l.cantidadTexto, 10) }))
        .filter((e) => Number.isInteger(e.cantidad) && e.cantidad > 0),
    [lineas],
  );

  // El selector de IVA solo ofrece 0.13 y 0, así que esto nunca debería
  // lanzar. El try/catch queda como red de seguridad: es preferible mostrar
  // ceros que tirar la pantalla completa si algo cambia el día de mañana.
  const cotizacion = useMemo(() => {
    try {
      return calcular(entradas, CATALOGO, { tasaIva, bordadoEspecial });
    } catch (e) {
      console.error('[cotizador] calcular() rechazó los datos de la vista previa.', e);
      return {
        lineas: [],
        subtotal: 0,
        ahorro: 0,
        tasaIva,
        iva: 0,
        total: 0,
        bordadoEspecial,
      };
    }
  }, [entradas, tasaIva, bordadoEspecial]);

  function agregar(skuId: string) {
    setResultado(null);
    setLineas((prev) => {
      const existente = prev.find((l) => l.skuId === skuId);
      if (!existente) return [...prev, { skuId, cantidadTexto: '1' }];
      const actual = Number.parseInt(existente.cantidadTexto, 10);
      const nueva = Number.isInteger(actual) && actual > 0 ? actual + 1 : 1;
      return prev.map((l) => (l.skuId === skuId ? { ...l, cantidadTexto: String(nueva) } : l));
    });
  }

  function cambiarCantidad(skuId: string, texto: string) {
    setLineas((prev) => prev.map((l) => (l.skuId === skuId ? { ...l, cantidadTexto: texto } : l)));
  }

  function quitar(skuId: string) {
    setLineas((prev) => prev.filter((l) => l.skuId !== skuId));
  }

  const correoValido = cliente.email.trim().length > 0;
  const puedeEnviar = !enviando && entradas.length > 0 && correoValido;

  async function enviar() {
    if (!puedeEnviar) return;
    setEnviando(true);
    setResultado(null);
    try {
      const res = await fetch('/api/cotizacion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clave,
          cliente: {
            nombre: cliente.nombre.trim(),
            empresa: cliente.empresa.trim() || undefined,
            email: cliente.email.trim(),
          },
          lineas: entradas,
          tasaIva,
          bordadoEspecial,
        }),
      });
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        setResultado({ ok: false, error: datos.error ?? `Error ${res.status}` });
        return;
      }
      setResultado({
        ok: true,
        id: datos.id,
        ghlEstimateId: datos.ghl?.estimateId,
        ghlError: datos.ghl?.error,
      });
    } catch (e) {
      setResultado({ ok: false, error: e instanceof Error ? e.message : 'Fallo de red.' });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="border-b border-[var(--carta-border)] pb-4">
        <h1 className="font-display text-xl text-navy">Cotizador</h1>
        <p className="text-xs text-teal">
          Armá la cotización por SKU. Los precios y descuentos los calcula el mismo motor que
          usa el servidor — lo que ves acá es exactamente lo que va a facturarse.
        </p>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section className="space-y-6">
          <div className="rounded-xl border border-[var(--carta-border)] bg-[var(--carta-fill)] p-4">
            <label htmlFor="buscador" className="text-xs font-medium uppercase tracking-wide text-teal">
              Buscar producto
            </label>
            <input
              id="buscador"
              aria-label="Buscar producto"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Nombre o familia (ej. «set de 600 hilos», «filipina»)…"
              className="mt-2 w-full rounded-lg border border-[var(--carta-border)] bg-white px-3 py-2.5 text-sm text-navy placeholder:text-teal/60"
            />
            {busqueda.trim() === '' ? (
              <p className="mt-3 text-xs text-teal/70">Escribí para buscar entre los {CATALOGO.length} productos del catálogo.</p>
            ) : resultadosBusqueda.length === 0 ? (
              <p className="mt-3 text-xs text-teal/70">Sin resultados para «{busqueda}».</p>
            ) : (
              <ul className="mt-3 divide-y divide-[var(--carta-border)]">
                {resultadosBusqueda.map((sku) => (
                  <li key={sku.id} className="flex items-center justify-between gap-3 py-2">
                    <div>
                      <p className="text-sm text-navy">{sku.nombre}</p>
                      <p className="text-xs text-teal">
                        {sku.familia} · {colones(sku.precioLista)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => agregar(sku.id)}
                      className="shrink-0 rounded-lg border border-[var(--carta-border)] px-3 py-1.5 text-xs font-medium text-navy hover:bg-navy hover:text-beige"
                    >
                      Agregar
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-[var(--carta-border)] bg-[var(--carta-fill)] p-4">
            <h2 className="text-xs font-medium uppercase tracking-wide text-teal">Líneas de la cotización</h2>
            {lineas.length === 0 ? (
              <p className="mt-3 text-sm text-teal">Todavía no agregaste ningún producto.</p>
            ) : (
              <ul className="mt-3 divide-y divide-[var(--carta-border)]">
                {lineas.map((linea) => {
                  const sku = buscarSku(linea.skuId);
                  if (!sku) return null;
                  const calculada = cotizacion.lineas.find((l) => l.skuId === linea.skuId);
                  return (
                    <li key={linea.skuId} className="py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm text-navy">{sku.nombre}</p>
                        <button
                          type="button"
                          onClick={() => quitar(linea.skuId)}
                          className="text-xs text-teal underline hover:text-navy"
                        >
                          Quitar
                        </button>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
                        <label className="flex items-center gap-2 text-xs text-teal">
                          Cantidad
                          <input
                            type="number"
                            min={1}
                            aria-label="Cantidad"
                            value={linea.cantidadTexto}
                            onChange={(e) => cambiarCantidad(linea.skuId, e.target.value)}
                            className="w-20 rounded-lg border border-[var(--carta-border)] bg-white px-2 py-1.5 text-sm text-navy"
                          />
                        </label>
                        <span className="text-teal">
                          Unitario:{' '}
                          <span className="text-navy">
                            {colones(calculada ? calculada.precioUnitario : sku.precioLista)}
                          </span>
                        </span>
                        <span className="text-teal">
                          Subtotal: <span className="text-navy">{colones(calculada?.subtotal ?? 0)}</span>
                        </span>
                      </div>
                      {calculada && (
                        <p className="mt-1 text-xs text-teal/80">{calculada.motivo}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <aside className="space-y-6">
          <div className="rounded-xl border border-[var(--carta-border)] bg-[var(--carta-fill)] p-4">
            <h2 className="text-xs font-medium uppercase tracking-wide text-teal">Total cotizado</h2>
            <p className="mt-1 font-display text-3xl text-navy">{colones(cotizacion.total)}</p>

            {lineas.length > 0 && (
              <dl className="mt-4 space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-teal">Subtotal</dt>
                  <dd className="text-navy">{colones(cotizacion.subtotal)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-teal">Ahorro por descuento</dt>
                  <dd className="text-navy">{colones(cotizacion.ahorro)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-teal">IVA ({Math.round(cotizacion.tasaIva * 100)}%)</dt>
                  <dd className="text-navy">{colones(cotizacion.iva)}</dd>
                </div>
              </dl>
            )}

            <label htmlFor="iva" className="mt-4 block text-xs font-medium uppercase tracking-wide text-teal">
              Tasa de IVA
            </label>
            <select
              id="iva"
              aria-label="Tasa de IVA"
              value={tasaIva}
              onChange={(e) => setTasaIva(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-[var(--carta-border)] bg-white px-3 py-2 text-sm text-navy"
            >
              <option value={IVA_GENERAL}>13%</option>
              <option value={0}>0%</option>
            </select>

            <label className="mt-4 flex items-start gap-2 text-sm text-navy">
              <input
                type="checkbox"
                checked={bordadoEspecial}
                onChange={(e) => setBordadoEspecial(e.target.checked)}
                className="mt-0.5"
              />
              <span>Bordado especial (mayor a 10×10 cm o a varios colores)</span>
            </label>
            {bordadoEspecial && (
              <p className="mt-2 rounded-lg bg-[color:var(--carta-border)]/30 px-3 py-2 text-xs text-navy">
                El precio final se confirma contra muestra. El bordado estándar ya está incluido
                en el precio de la prenda.
              </p>
            )}
          </div>

          <div className="rounded-xl border border-[var(--carta-border)] bg-[var(--carta-fill)] p-4">
            <h2 className="text-xs font-medium uppercase tracking-wide text-teal">Datos del cliente</h2>
            <div className="mt-3 space-y-3">
              <label className="block text-xs text-teal">
                Nombre
                <input
                  aria-label="Nombre del cliente"
                  value={cliente.nombre}
                  onChange={(e) => setCliente((c) => ({ ...c, nombre: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-[var(--carta-border)] bg-white px-3 py-2 text-sm text-navy"
                />
              </label>
              <label className="block text-xs text-teal">
                Empresa (opcional)
                <input
                  aria-label="Empresa del cliente"
                  value={cliente.empresa}
                  onChange={(e) => setCliente((c) => ({ ...c, empresa: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-[var(--carta-border)] bg-white px-3 py-2 text-sm text-navy"
                />
              </label>
              <label className="block text-xs text-teal">
                Correo
                <input
                  type="email"
                  aria-label="Correo del cliente"
                  value={cliente.email}
                  onChange={(e) => setCliente((c) => ({ ...c, email: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-[var(--carta-border)] bg-white px-3 py-2 text-sm text-navy"
                />
              </label>
              <label className="block text-xs text-teal">
                Clave
                <input
                  type="password"
                  aria-label="Clave"
                  value={clave}
                  onChange={(e) => setClave(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-[var(--carta-border)] bg-white px-3 py-2 text-sm text-navy"
                />
              </label>
            </div>

            <button
              type="button"
              onClick={() => void enviar()}
              disabled={!puedeEnviar}
              className="mt-4 w-full rounded-lg bg-navy px-4 py-2.5 text-sm font-medium text-beige hover:bg-teal disabled:opacity-40"
            >
              {enviando ? 'Enviando…' : 'Enviar cotización'}
            </button>

            {resultado && resultado.ok && (
              <p className="mt-3 rounded-lg bg-[color:var(--carta-border)]/30 px-3 py-2 text-xs text-navy">
                Cotización guardada · {resultado.id}
                {resultado.ghlEstimateId
                  ? ` · enviada en GoHighLevel (${resultado.ghlEstimateId})`
                  : resultado.ghlError
                    ? ` · GoHighLevel falló: ${resultado.ghlError}`
                    : ''}
              </p>
            )}
            {resultado && !resultado.ok && (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">{resultado.error}</p>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
