'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Cotizacion, LineaEntrada } from '@/lib/cotizador/tipos';

// Tasa general de IVA en Costa Rica. Duplicada a propósito: es un dato
// público (no comercial, a diferencia de `precioLista` o de `ESCALAS`), y
// esta pantalla ya no puede importar `lib/cotizador/escalas.ts` — arrastraría
// la estructura de descuentos por volumen al navegador. Ver Tarea 8.
const IVA_GENERAL = 0.13;

// Lo único que el vendedor necesita para buscar y elegir un SKU. Nada de
// `precioLista` ni `grupo`: eso es la lista de precios de Luxe, y esta forma
// es la que de verdad viaja al navegador (la sirve `/api/cotizacion/catalogo`,
// tras clave). Ver Tarea 8.
type SkuUI = { id: string; nombre: string; familia: string };

type Cliente = { nombre: string; empresa: string; email: string };

// Una línea por SKU, tal como la ve el vendedor. `cantidadTexto` guarda
// exactamente lo que hay en el input: si se guardara ya como número, borrar
// el campo para escribir uno nuevo forzaría a mostrar "0" en vez de vacío.
type LineaUI = { skuId: string; cantidadTexto: string };

type Resultado =
  | { ok: true; id: string; ghlEstimateId?: string; ghlError?: string }
  | { ok: false; error: string };

const CLIENTE_VACIO: Cliente = { nombre: '', empresa: '', email: '' };

const COTIZACION_VACIA: Cotizacion = {
  lineas: [],
  subtotal: 0,
  ahorro: 0,
  tasaIva: IVA_GENERAL,
  iva: 0,
  total: 0,
  bordadoEspecial: false,
};

type ValidacionCantidad = { ok: true; cantidad: number } | { ok: false; mensaje: string };

// Cualquier cosa que no sea "un entero positivo, escrito tal cual" se
// rechaza de forma visible. `Number.parseInt('2.5', 10)` da 2 sin quejarse
// — eso dejaba la pantalla mostrando "2.5" mientras cotizaba 2, en silencio.
// Lo mismo con el campo vacío: antes esa línea desaparecía del cálculo (y
// del envío) sin avisar, así que el vendedor mandaba una cotización con
// menos productos de los que veía en pantalla. Ver revisión de la Tarea 8.
function validarCantidad(texto: string): ValidacionCantidad {
  const t = texto.trim();
  if (t === '') return { ok: false, mensaje: 'Falta la cantidad.' };
  if (!/^\d+$/.test(t)) return { ok: false, mensaje: 'Debe ser un entero, sin decimales.' };
  const cantidad = Number.parseInt(t, 10);
  if (cantidad <= 0) return { ok: false, mensaje: 'Debe ser mayor que cero.' };
  // Mismo tope que `cotizacionSchema` en lib/validation.ts: si el servidor lo
  // va a rechazar de todas formas, mejor avisarlo aquí que dejar que el envío
  // final vuelva con un 400 que el vendedor no esperaba.
  if (cantidad > 10000) return { ok: false, mensaje: 'No puede superar 10.000 unidades.' };
  return { ok: true, cantidad };
}

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
  const [dentro, setDentro] = useState(false);
  const [claveError, setClaveError] = useState('');
  const [entrando, setEntrando] = useState(false);
  const [skus, setSkus] = useState<SkuUI[]>([]);

  const [cliente, setCliente] = useState<Cliente>(CLIENTE_VACIO);
  const [busqueda, setBusqueda] = useState('');
  const [lineas, setLineas] = useState<LineaUI[]>([]);
  const [tasaIva, setTasaIva] = useState(IVA_GENERAL);
  const [bordadoEspecial, setBordadoEspecial] = useState(false);
  const [enviando, setEnviando] = useState(false);
  // Distinto de `enviando`: `enviando` es "la petición está en vuelo",
  // `enviado` es "ya se guardó con éxito". Sin este segundo estado, tras un
  // envío exitoso el botón volvía a quedar habilitado y un segundo clic
  // creaba otra fila en Supabase y otro Estimate en GoHighLevel. Ver
  // revisión de la Tarea 8.
  const [enviado, setEnviado] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  // La vista previa (Tarea 8): ya no hay `calcular` ni catálogo en el
  // navegador, así que el total y el desglose por línea vienen de
  // `/api/cotizacion/previsualizar`, con el mismo motor que usa el envío
  // final. `previaError` es de la previsualización, no del envío — se
  // muestra aparte de `resultado`.
  const [cotizacion, setCotizacion] = useState<Cotizacion>(COTIZACION_VACIA);
  const [previsualizando, setPrevisualizando] = useState(false);
  const [previaError, setPreviaError] = useState('');

  const porId = useMemo(() => new Map(skus.map((s) => [s.id, s])), [skus]);

  const resultadosBusqueda = useMemo(() => {
    const q = normalizar(busqueda.trim());
    if (!q) return [];
    return skus
      .filter((sku) => normalizar(sku.nombre).includes(q) || normalizar(sku.familia).includes(q))
      .slice(0, 20);
  }, [busqueda, skus]);

  // Solo las líneas con una cantidad válida entran al cálculo y al envío.
  // `hayLineaInvalida` es lo que de verdad bloquea el botón: una línea con
  // el campo vacío o con un decimal no debe desaparecer en silencio del
  // pedido, tiene que impedir que el pedido salga.
  const entradas: LineaEntrada[] = useMemo(() => {
    const validas: LineaEntrada[] = [];
    for (const l of lineas) {
      const v = validarCantidad(l.cantidadTexto);
      if (v.ok) validas.push({ skuId: l.skuId, cantidad: v.cantidad });
    }
    return validas;
  }, [lineas]);

  const hayLineaInvalida = useMemo(
    () => lineas.some((l) => !validarCantidad(l.cantidadTexto).ok),
    [lineas],
  );

  // Vista previa con rebote de 300ms: cada cambio en las líneas, la tasa de
  // IVA o el bordado especial reinicia el temporizador en vez de disparar una
  // llamada por tecla. `AbortController` corta una respuesta que llegue tarde
  // (p. ej. si el vendedor sigue escribiendo) para que no pise un resultado
  // más nuevo.
  useEffect(() => {
    if (!dentro) return;
    if (entradas.length === 0) {
      setCotizacion({ ...COTIZACION_VACIA, tasaIva, bordadoEspecial });
      setPreviaError('');
      setPrevisualizando(false);
      return;
    }

    const controlador = new AbortController();
    const temporizador = setTimeout(() => {
      setPrevisualizando(true);
      fetch('/api/cotizacion/previsualizar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clave, lineas: entradas, tasaIva, bordadoEspecial }),
        signal: controlador.signal,
      })
        .then(async (res) => {
          const datos = await res.json();
          if (!res.ok || !datos.ok) {
            setPreviaError(datos.error ?? `Error ${res.status}`);
            return;
          }
          setCotizacion(datos.cotizacion);
          setPreviaError('');
        })
        .catch((e) => {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          // Nunca `e.message`: para un fallo de red eso es "Failed to fetch"
          // en inglés, sin sentido para el vendedor. Ver revisión de la
          // Tarea 8.
          setPreviaError('Fallo de red.');
        })
        .finally(() => setPrevisualizando(false));
    }, 300);

    return () => {
      clearTimeout(temporizador);
      controlador.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `entradas` ya está memoizado sobre `lineas`.
  }, [entradas, tasaIva, bordadoEspecial, dentro, clave]);

  function agregar(skuId: string) {
    setResultado(null);
    setEnviado(false);
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

  // Reinicia el formulario para armar una cotización nueva. Es la única
  // forma de volver a habilitar el envío después de uno exitoso — un
  // segundo clic sobre el mismo botón ya no alcanza, a propósito.
  function nuevaCotizacion() {
    setLineas([]);
    setCliente(CLIENTE_VACIO);
    setBusqueda('');
    setTasaIva(IVA_GENERAL);
    setBordadoEspecial(false);
    setResultado(null);
    setEnviado(false);
    setCotizacion(COTIZACION_VACIA);
    setPreviaError('');
  }

  const correoValido = cliente.email.trim().length > 0;
  // El servidor (cotizacionSchema en lib/validation.ts) exige `cliente.nombre`
  // igual que exige el correo. El botón tiene que pedir lo mismo que el
  // servidor: si solo revisa el correo, deja enviar y volver con un 400
  // evitable. Ver revisión de la Tarea 8.
  const nombreValido = cliente.nombre.trim().length > 0;
  const puedeEnviar =
    !enviando && !enviado && lineas.length > 0 && !hayLineaInvalida && correoValido && nombreValido;

  // La pantalla de clave: sin ella no hay catálogo. `/api/cotizacion/catalogo`
  // es quien valida la clave y quien decide qué SKUs bajan al navegador (sin
  // precios). Al estilo de app/q7m4/Taller.tsx.
  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setClaveError('');
    setEntrando(true);
    try {
      const res = await fetch('/api/cotizacion/catalogo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clave }),
      });
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        setClaveError(res.status === 401 ? 'Clave incorrecta.' : (datos.error ?? `Error ${res.status}`));
        return;
      }
      setSkus(datos.skus);
      setDentro(true);
    } catch {
      setClaveError('Fallo de red.');
    } finally {
      setEntrando(false);
    }
  }

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
      // A partir de aquí el pedido ya existe en Supabase (y probablemente en
      // GoHighLevel): `puedeEnviar` pasa a false y se queda así hasta que el
      // vendedor pida explícitamente una cotización nueva.
      setEnviado(true);
    } catch {
      setResultado({ ok: false, error: 'Fallo de red.' });
    } finally {
      setEnviando(false);
    }
  }

  if (!dentro) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <form onSubmit={entrar} className="w-full max-w-xs">
          <h1 className="font-display text-2xl text-navy">Cotizador</h1>
          <p className="mt-2 text-sm text-teal">Luxe Essentials</p>
          <input
            type="password"
            aria-label="Clave"
            value={clave}
            onChange={(e) => setClave(e.target.value)}
            placeholder="Clave"
            autoFocus
            className="mt-6 w-full rounded-lg border border-[var(--carta-border)] bg-white px-4 py-3 text-sm text-navy placeholder:text-teal/60"
          />
          {claveError && <p className="mt-2 text-sm text-red-700">{claveError}</p>}
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
              <p className="mt-3 text-xs text-teal/70">Escribí para buscar entre los {skus.length} productos del catálogo.</p>
            ) : resultadosBusqueda.length === 0 ? (
              <p className="mt-3 text-xs text-teal/70">Sin resultados para «{busqueda}».</p>
            ) : (
              <ul className="mt-3 divide-y divide-[var(--carta-border)]">
                {resultadosBusqueda.map((sku) => (
                  <li key={sku.id} className="flex items-center justify-between gap-3 py-2">
                    <div>
                      <p className="text-sm text-navy">{sku.nombre}</p>
                      <p className="text-xs text-teal">{sku.familia}</p>
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
                  const sku = porId.get(linea.skuId);
                  if (!sku) return null;
                  const validacion = validarCantidad(linea.cantidadTexto);
                  const calculada = validacion.ok
                    ? cotizacion.lineas.find((l) => l.skuId === linea.skuId)
                    : undefined;
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
                            aria-invalid={!validacion.ok}
                            value={linea.cantidadTexto}
                            onChange={(e) => cambiarCantidad(linea.skuId, e.target.value)}
                            className={`w-20 rounded-lg border bg-white px-2 py-1.5 text-sm text-navy ${
                              validacion.ok ? 'border-[var(--carta-border)]' : 'border-red-400'
                            }`}
                          />
                        </label>
                        <span className="text-teal">
                          Unitario:{' '}
                          <span className="text-navy">
                            {calculada ? colones(calculada.precioUnitario) : '…'}
                          </span>
                        </span>
                        <span className="text-teal">
                          Subtotal:{' '}
                          <span className="text-navy">{calculada ? colones(calculada.subtotal) : '…'}</span>
                        </span>
                      </div>
                      {!validacion.ok && (
                        <p className="mt-1 text-xs text-red-700">{validacion.mensaje}</p>
                      )}
                      {validacion.ok && calculada && (
                        <p className="mt-1 text-xs text-teal/80">{calculada.motivo}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {hayLineaInvalida && (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
                Hay líneas con la cantidad incompleta o inválida — corregilas o quitalas para
                poder enviar la cotización.
              </p>
            )}
          </div>
        </section>

        <aside className="space-y-6">
          <div className="rounded-xl border border-[var(--carta-border)] bg-[var(--carta-fill)] p-4">
            <h2 className="text-xs font-medium uppercase tracking-wide text-teal">Total cotizado</h2>
            <p className="mt-1 font-display text-3xl text-navy">{colones(cotizacion.total)}</p>
            {previsualizando && <p className="mt-1 text-xs text-teal/70">Calculando…</p>}
            {previaError && (
              <p className="mt-1 text-xs text-red-700">{previaError}</p>
            )}

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
            </div>

            <button
              type="button"
              onClick={() => void enviar()}
              disabled={!puedeEnviar}
              className="mt-4 w-full rounded-lg bg-navy px-4 py-2.5 text-sm font-medium text-beige hover:bg-teal disabled:opacity-40"
            >
              {enviando ? 'Enviando…' : enviado ? 'Cotización enviada' : 'Enviar cotización'}
            </button>

            {enviado && (
              <button
                type="button"
                onClick={nuevaCotizacion}
                className="mt-2 w-full rounded-lg border border-[var(--carta-border)] px-4 py-2.5 text-sm font-medium text-navy hover:bg-navy hover:text-beige"
              >
                Nueva cotización
              </button>
            )}

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
