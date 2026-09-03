'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Cotizacion, LineaCalculada, LineaEntrada } from '@/lib/cotizador/tipos';
import type { PrefillCotizacion, SkuUI } from './Panel';
import { formatearColones, formatearTasa } from './formato';

// Tasa general de IVA en Costa Rica. Duplicada a propósito: es un dato
// público (no comercial, a diferencia de `precioLista` o de `ESCALAS`), y
// esta pantalla ya no puede importar `lib/cotizador/escalas.ts` — arrastraría
// la estructura de descuentos por volumen al navegador. Ver Tarea 8.
const IVA_GENERAL = 0.13;

// `telefono` y `direccion` (Tarea 5) son opcionales a propósito: un hotel
// que cotiza por correo puede no tener todavía una dirección de entrega
// definida, y bloquear el envío por eso sería estorbar. Cuando existen,
// salen impresos en el PDF (lib/cotizador/documento.tsx).
type Cliente = { nombre: string; empresa: string; email: string; telefono: string; direccion: string };

// Lo que deja el agente cuando captura una intención por WhatsApp: quién es
// el cliente, qué línea le interesa y cuánto pidió, en texto libre. `cliente`
// es un jsonb sin forma fija — se lee con `textoDe` para no asumir que un
// campo existe o es string. Ver Tarea 9 (`registrarIntencion`) y Tarea 10.
type Borrador = {
  id: string;
  created_at: string;
  contact_id: string | null;
  cliente: Record<string, unknown>;
};

// Lo que queda visible tras apretar "Usar" en un borrador: el pedido del
// cliente, en sus propias palabras, para que el vendedor elija los SKUs
// contra eso — no contra un número que alguien más interpretó por él.
type Recordatorio = { producto: string; cantidadTexto: string };

// Ronda de correcciones 2 (hallazgo I1): qué borrador del agente está detrás
// de la cotización que se está armando, si hay uno. Se manda de vuelta al
// servidor con el envío final para que:
// 1. cierre esa fila (estado 'convertida') — si no, se queda en 'borrador'
//    para siempre, la cola del vendedor nunca se vacía, y peor,
//    `registrarIntencion` (lib/cotizador/borrador.ts) deja de registrar
//    intenciones nuevas de ese contacto para siempre.
// 2. reutilice el `contactId` que el borrador ya trae, en vez de crear un
//    contacto nuevo en GoHighLevel para alguien que ya existe ahí.
type BorradorActivo = { id: string; contactId: string | null };

// "Modificar" (migración 0016): qué cotización vieja está detrás de la que
// se está armando, si vino de esa acción (no de "Duplicar" a secas, ni de
// "Crear" desde cero). Igual que `BorradorActivo`, se manda de vuelta al
// servidor con el envío final -- `reemplazaId` para que la marque
// 'reemplazada' (recién cuando el envío sale bien, nunca antes: ver
// app/api/cotizacion/route.ts) y `contactId` para reutilizar el contacto de
// GoHighLevel de esa cotización vieja en vez de dar de alta uno nuevo.
// `numero` es sólo para el aviso que ve el vendedor acá abajo -- el
// servidor relee el numero real, nunca confía en éste.
type ReemplazaActivo = { id: string; contactId: string | null; numero: string };

// El jsonb `cliente` de un borrador no tiene forma garantizada: se lee campo
// por campo, y cualquier cosa que no sea string se trata como ausente en vez
// de reventar la pantalla.
function textoDe(valor: unknown): string {
  return typeof valor === 'string' ? valor : '';
}

// Una línea por SKU, tal como la ve el vendedor. `cantidadTexto` guarda
// exactamente lo que hay en el input: si se guardara ya como número, borrar
// el campo para escribir uno nuevo forzaría a mostrar "0" en vez de vacío.
type LineaUI = { skuId: string; cantidadTexto: string };

// Ronda de correcciones 1 (Tarea 5): antes esto solo cargaba el resultado de
// GoHighLevel — la pantalla no tenía forma de saber si el correo con el PDF
// había salido. Ahora la respuesta del servidor trae `pdf`/`correo`
// (app/api/cotizacion/route.ts) y el panel de resultado los lee para decir
// la verdad: a quién le llegó, o por qué no le llegó.
type Resultado =
  | {
      ok: true;
      id: string;
      numero?: string;
      pdf: { ruta: string } | null;
      correo: { resendId: string } | { error: string };
      ghlEstimateId?: string;
      ghlError?: string;
    }
  | { ok: false; error: string };

const CLIENTE_VACIO: Cliente = { nombre: '', empresa: '', email: '', telefono: '', direccion: '' };

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

// Fecha y hora en formato fijo (dd/mm/aaaa hh:mm), sin depender de la
// configuración regional del navegador del vendedor — mismo motivo que
// `formatearColones` evita `toLocaleString` para los montos.
function formatearFecha(iso: string): string {
  const f = new Date(iso);
  if (Number.isNaN(f.getTime())) return iso;
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${dos(f.getDate())}/${dos(f.getMonth() + 1)}/${f.getFullYear()} ${dos(f.getHours())}:${dos(f.getMinutes())}`;
}

// Una fila de producto, con su botón "Agregar". La usan tanto los
// resultados de la búsqueda como el catálogo desplegable por familia (ver
// más abajo) — un solo marcado para las dos vías de elegir un SKU, así que
// un cambio de estilo o de comportamiento no puede quedar aplicado a una
// sí y a la otra no. Ya no es el `<li>` completo (lo envuelve `ItemCatalogo`,
// más abajo): así el mismo bloque nombre+botón puede compartir `<li>` con los
// controles de cantidad, cuando el producto ya está en la cotización.
function FilaSku({ sku, onAgregar }: { sku: SkuUI; onAgregar: (skuId: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div>
        <p className="text-sm text-navy">{sku.nombre}</p>
        <p className="text-xs text-teal">{sku.familia}</p>
      </div>
      <button
        type="button"
        onClick={() => onAgregar(sku.id)}
        className="shrink-0 rounded-lg border border-[var(--carta-border)] px-3 py-1.5 text-xs font-medium text-navy hover:bg-navy hover:text-beige"
      >
        Agregar
      </button>
    </div>
  );
}

// Cantidad + quitar + el desglose que ya calculó el servidor, para una línea.
// Es el corazón del cambio de esta pantalla: antes vivía SOLO dentro de
// "Líneas de la cotización", más abajo de todo el catálogo — agregar un
// producto y tener que bajar a ponerle cantidad era exactamente la queja.
// Ahora el mismo bloque se monta, sin duplicarse, en el lugar donde el
// producto está visible: bajo su fila en la búsqueda o en el catálogo por
// familia (`ItemCatalogo`) si esa fila sigue en pantalla, o en la lista de
// respaldo más abajo si dejó de estarlo (búsqueda cambiada, familia nunca
// desplegada, o el producto salió del catálogo). Nunca las dos a la vez —
// `lineasDeRespaldo`, en `VistaCrear`, decide cuál.
function ControlesLinea({
  linea,
  calculada,
  onCambiarCantidad,
  onQuitar,
  registrarInputCantidad,
}: {
  linea: LineaUI;
  calculada: LineaCalculada | undefined;
  onCambiarCantidad: (skuId: string, texto: string) => void;
  onQuitar: (skuId: string) => void;
  registrarInputCantidad: (skuId: string, el: HTMLInputElement | null) => void;
}) {
  const validacion = validarCantidad(linea.cantidadTexto);
  // Un id estable por SKU: como esta línea nunca se pinta en dos sitios a la
  // vez, no hace falta variarlo según de dónde se monte.
  const idCantidad = `cantidad-${linea.skuId}`;
  return (
    <div className="mt-1 rounded-lg bg-[color:var(--carta-border)]/20 px-2 py-2">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label htmlFor={idCantidad} className="flex items-center gap-2 text-xs text-teal">
          Cantidad
          <input
            id={idCantidad}
            ref={(el) => registrarInputCantidad(linea.skuId, el)}
            type="number"
            min={1}
            aria-label="Cantidad"
            aria-invalid={!validacion.ok}
            value={linea.cantidadTexto}
            onChange={(e) => onCambiarCantidad(linea.skuId, e.target.value)}
            className={`w-20 rounded-lg border bg-white px-2 py-1.5 text-sm text-navy ${
              validacion.ok ? 'border-[var(--carta-border)]' : 'border-red-400'
            }`}
          />
        </label>
        <span className="text-teal">
          Unitario: <span className="text-navy">{calculada ? formatearColones(calculada.precioUnitario) : '…'}</span>
        </span>
        <span className="text-teal">
          Subtotal: <span className="text-navy">{calculada ? formatearColones(calculada.subtotal) : '…'}</span>
        </span>
        <button
          type="button"
          onClick={() => onQuitar(linea.skuId)}
          className="ml-auto text-xs text-teal underline hover:text-navy"
        >
          Quitar
        </button>
      </div>
      {!validacion.ok && <p className="mt-1 text-xs text-red-700">{validacion.mensaje}</p>}
      {validacion.ok && calculada && <p className="mt-1 text-xs text-teal/80">{calculada.motivo}</p>}
    </div>
  );
}

// Una fila del catálogo (búsqueda o familia), con sus controles de cantidad
// desplegados justo debajo cuando el producto ya está en la cotización.
// `linea` viene `undefined` mientras no se agregó nada — en ese caso es
// exactamente `FilaSku` sola, como antes.
function ItemCatalogo({
  sku,
  linea,
  calculada,
  onAgregar,
  onCambiarCantidad,
  onQuitar,
  registrarInputCantidad,
}: {
  sku: SkuUI;
  linea: LineaUI | undefined;
  calculada: LineaCalculada | undefined;
  onAgregar: (skuId: string) => void;
  onCambiarCantidad: (skuId: string, texto: string) => void;
  onQuitar: (skuId: string) => void;
  registrarInputCantidad: (skuId: string, el: HTMLInputElement | null) => void;
}) {
  return (
    <li className="py-1">
      <FilaSku sku={sku} onAgregar={onAgregar} />
      {linea && (
        <ControlesLinea
          linea={linea}
          calculada={calculada}
          onCambiarCantidad={onCambiarCantidad}
          onQuitar={onQuitar}
          registrarInputCantidad={registrarInputCantidad}
        />
      )}
    </li>
  );
}

type Props = {
  // El catálogo (sin precios) que ya bajó `Panel` tras validar la sesión.
  skus: SkuUI[];
  // Lee el token anti-CSRF vigente desde `sessionStorage` (lo guarda `Panel`
  // al validar la clave, o al confirmar una sesión ya viva). `null` si
  // todavía no hay uno.
  obtenerCsrf: () => string | null;
  // Ronda de correcciones 1 (hallazgo crítico): si el envío final vuelve
  // con 401, el token guardado ya no sirve — quedarse en esta vista dejaría
  // al vendedor con una pantalla que lee pero nunca puede volver a escribir.
  // `Panel` limpia la sesión y vuelve a pedir usuario y clave.
  onSesionInvalida: () => void;
  // Tarea 10 ("Duplicar"): lo que dejó `VistaListado` para arrancar esta
  // vista ya cargada, en vez de en blanco. `null`/`undefined` cuando se
  // entra a "Crear" sin duplicar nada — el caso de siempre.
  plantilla?: PrefillCotizacion | null;
  // Se llama una sola vez, al montar, si `plantilla` no era nula — para que
  // `Panel` la limpie y un futuro remonte de esta pestaña no la reaplique.
  onPlantillaConsumida?: () => void;
};

// Todo lo que antes vivía en `Cotizador.tsx` después de la pantalla de
// clave: buscador, líneas, totales, envío y la cola de borradores del
// agente. Extraído en la Tarea 9 — el comportamiento es el mismo, solo
// cambia de dónde saca la clave y de dónde consigue el catálogo.
export function VistaCrear({
  skus,
  obtenerCsrf,
  onSesionInvalida,
  plantilla,
  onPlantillaConsumida,
}: Props) {
  // La cola de borradores del agente (Tarea 10): se pide una sola vez, al
  // montar esta vista — que es exactamente cuando antes se pedía, justo
  // después de validar la clave.
  const [borradores, setBorradores] = useState<Borrador[]>([]);
  const [cargandoBorradores, setCargandoBorradores] = useState(false);
  const [borradoresError, setBorradoresError] = useState('');
  const [recordatorio, setRecordatorio] = useState<Recordatorio | null>(null);
  // Ronda de correcciones 2 (hallazgo I1): ver el comentario de
  // `BorradorActivo` arriba.
  const [borradorActivo, setBorradorActivo] = useState<BorradorActivo | null>(null);
  // "Modificar": ver el comentario de `ReemplazaActivo` arriba.
  const [reemplazaActivo, setReemplazaActivo] = useState<ReemplazaActivo | null>(null);

  // Tarea 10 ("Duplicar"). Ronda de correcciones 1 (hallazgo importante):
  // esta vista YA NO se desmonta al cambiar de pestaña (ver Panel.tsx) —
  // sigue viva de fondo para no perderle al vendedor la cotización a medio
  // armar—, así que un `useState` perezoso que solo mira el primer render
  // ya no alcanza: un segundo "Duplicar" mientras esta vista sigue montada
  // nunca se aplicaría. Por eso arranca vacía y un efecto (más abajo,
  // después de declarar `lineas`) reacciona a CADA cambio de `plantilla`.
  const [cliente, setCliente] = useState<Cliente>(CLIENTE_VACIO);
  const [busqueda, setBusqueda] = useState('');
  const [lineas, setLineas] = useState<LineaUI[]>([]);
  const [tasaIva, setTasaIva] = useState(IVA_GENERAL);
  const [bordadoEspecial, setBordadoEspecial] = useState(false);
  // Nombres de variable sin cambiar desde la ronda "final-fix-C" (cuando el
  // botón no enviaba nada, solo creaba un Estimate en borrador), pero el
  // texto que ve el vendedor sí cambió en la Tarea 5, ronda de correcciones
  // 1: ahora `crear()` sí manda la cotización de verdad (correo con el PDF
  // adjunto), así que el JSX del botón usa "Cotizar y enviar"/"Enviando…" —
  // ver más abajo. `creando`/`creado` siguen describiendo el estado de la
  // petición a `/api/cotizacion`, no el rótulo visible.
  const [creando, setCreando] = useState(false);
  // Distinto de `creando`: `creando` es "la petición está en vuelo",
  // `creado` es "ya se guardó con éxito". Sin este segundo estado, tras un
  // envío exitoso el botón volvía a quedar habilitado y un segundo clic
  // creaba otra fila en Supabase y otro Estimate en GoHighLevel. Ver
  // revisión de la Tarea 8.
  const [creado, setCreado] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  // Revisión final (hallazgo menor, M2): `ghlError` es la respuesta cruda
  // que mandó GoHighLevel -- en inglés, a veces con JSON adentro (ver
  // AvisoError en VistaListado.tsx, que esconde el mismo tipo de texto
  // detrás de un clic). Acá se pintaba directo, sin esconder nada, en la
  // pantalla que el vendedor mira justo después de cada envío -- la más
  // probable para que lo vea. Colapsado por defecto, igual que en el
  // listado: no está a la vista mientras nadie lo pida.
  const [detalleGhlAbierto, setDetalleGhlAbierto] = useState(false);

  // La vista previa (Tarea 8): ya no hay `calcular` ni catálogo en el
  // navegador, así que el total y el desglose por línea vienen de
  // `/api/cotizacion/previsualizar`, con el mismo motor que usa el envío
  // final. `previaError` es de la previsualización, no del envío — se
  // muestra aparte de `resultado`.
  const [cotizacion, setCotizacion] = useState<Cotizacion>(COTIZACION_VACIA);
  const [previsualizando, setPrevisualizando] = useState(false);
  const [previaError, setPreviaError] = useState('');

  // Qué línea acaba de agregarse (por skuId): dispara el efecto de foco de
  // más abajo, que la lleva al campo de cantidad recién montado. `null` en
  // reposo — no hay ninguna espera pendiente.
  const [focoPendiente, setFocoPendiente] = useState<string | null>(null);
  // Un input de cantidad por skuId, sea que esté montado inline (búsqueda o
  // catálogo) o en la lista de respaldo — nunca los dos al mismo tiempo, así
  // que un solo registro alcanza para saber a cuál enfocar.
  const inputsCantidadRef = useRef(new Map<string, HTMLInputElement>());
  function registrarInputCantidad(skuId: string, el: HTMLInputElement | null) {
    if (el) inputsCantidadRef.current.set(skuId, el);
    else inputsCantidadRef.current.delete(skuId);
  }

  const porId = useMemo(() => new Map(skus.map((s) => [s.id, s])), [skus]);
  const lineaPorSkuId = useMemo(() => new Map(lineas.map((l) => [l.skuId, l])), [lineas]);
  const calculadaPorSkuId = useMemo(
    () => new Map(cotizacion.lineas.map((l) => [l.skuId, l])),
    [cotizacion.lineas],
  );

  const resultadosBusqueda = useMemo(() => {
    const q = normalizar(busqueda.trim());
    if (!q) return [];
    return skus
      .filter((sku) => normalizar(sku.nombre).includes(q) || normalizar(sku.familia).includes(q))
      .slice(0, 20);
  }, [busqueda, skus]);

  // Para quien no se sabe el nombre de memoria: el catálogo completo,
  // agrupado como la gente ya lo piensa (uniformes, sets de cama, toallas…)
  // en vez de una lista plana de 70 productos. `familia` es la misma que ya
  // trae cada SKU (lib/cotizador/tipos.ts) — no es una taxonomía nueva, es
  // la que ya existía para agruparlos en la pantalla y en el PDF. El orden
  // es el de primera aparición en `skus` (que ya llega agrupado por familia
  // desde el catálogo), no alfabético — así "Uniformes" queda primero, que
  // es la familia con más SKUs y la que más gente busca.
  const familiasCatalogo = useMemo(() => {
    const porFamilia = new Map<string, SkuUI[]>();
    for (const sku of skus) {
      const lista = porFamilia.get(sku.familia);
      if (lista) lista.push(sku);
      else porFamilia.set(sku.familia, [sku]);
    }
    return Array.from(porFamilia.entries()).map(([familia, items]) => ({ familia, items }));
  }, [skus]);

  // Las familias que tienen al menos una línea agregada se despliegan solas
  // (ver el `<details open>` más abajo) — sin esto, la fila con sus
  // controles de cantidad quedaría montada pero invisible dentro de un
  // desplegable cerrado, y el foco (más abajo) no tendría a dónde ir.
  const familiasConLineas = useMemo(() => {
    const set = new Set<string>();
    for (const l of lineas) {
      const sku = porId.get(l.skuId);
      if (sku) set.add(sku.familia);
    }
    return set;
  }, [lineas, porId]);

  // Toda familia con una línea queda forzada a abierta (arriba), así que en
  // modo catálogo (buscador vacío) cualquier línea válida ya está visible
  // ahí mismo. La lista de respaldo, más abajo en "Líneas de la cotización",
  // solo necesita cargar con lo que el catálogo no puede mostrar en su
  // lugar: un producto descontinuado (no está en ningún lado del catálogo) o,
  // en modo búsqueda, una línea cuyo producto ya no coincide con lo que hay
  // escrito ahora. Así el control de cantidad de una línea nunca aparece
  // duplicado en dos sitios, pero tampoco desaparece: si el catálogo no lo
  // puede mostrar, lo muestra acá.
  const lineasDeRespaldo = useMemo(() => {
    return lineas.filter((l) => {
      const sku = porId.get(l.skuId);
      if (!sku) return true;
      if (busqueda.trim() !== '') return !resultadosBusqueda.some((s) => s.id === l.skuId);
      return false;
    });
  }, [lineas, porId, busqueda, resultadosBusqueda]);

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

  // Ronda de correcciones 1 (hallazgo importante): una linea que llego por
  // "Duplicar" puede referirse a un SKU que ya no esta en el catalogo
  // vigente (`porId` sale de `skus`, lo que de verdad se puede vender hoy).
  // El servidor la rechaza de todas formas (`calcular` lanza, 400) -- eso
  // ya funcionaba -- pero antes esa linea se pintaba como si no existiera
  // (`porId.get` devolvia `undefined` y el `.map` la saltaba con `return
  // null`), asi que el vendedor veia un error que nombraba un producto que
  // no estaba en pantalla, sin boton para quitarlo, y la unica salida era
  // abandonar la cotizacion entera. Ahora esas lineas se pintan igual (ver
  // el `.map` de abajo) y esto bloquea el envio hasta que se quiten -- no
  // tiene sentido dejar avanzar un pedido que el servidor va a rechazar
  // seguro.
  const hayLineaDescontinuada = useMemo(() => lineas.some((l) => !porId.has(l.skuId)), [lineas, porId]);

  // Aplica una plantilla nueva de "Duplicar" (Tarea 10, ronda de
  // correcciones 1) o de "Modificar" (migración 0016). Reacciona a CADA
  // cambio de `plantilla` -- no solo al montar -- porque esta vista ya no
  // se desmonta al salir de la pestaña "Crear" (ver Panel.tsx): el vendedor
  // puede duplicar, volver a "Cotizaciones", duplicar OTRA fila y volver,
  // todo sin que esta vista se haya reiniciado nunca. Pisa el cliente y las
  // lineas que hubiera (mismo criterio que ya tenia `nuevaCotizacion`:
  // empezar de nuevo es explicito, el vendedor lo pidio con el clic en
  // "Duplicar"/"Modificar"). Avisa a `Panel` que ya la aplico para que la
  // limpie -- si no, un cambio futuro de `plantilla` a la misma referencia
  // (o un remonte) la reaplicaria de nuevo.
  //
  // `setReemplazaActivo` se fija SIEMPRE (a un valor o a `null`), no solo
  // cuando `plantilla.reemplazaId` existe: sin el `else` implicito acá, un
  // "Modificar" que dejó `reemplazaActivo` puesto sobreviviría a un
  // "Duplicar" posterior sobre OTRA fila (`plantilla` cambia, pero
  // `reemplazaId` ya no viene) -- el envío final mandaría un `reemplazaId`
  // de una cotización que el vendedor ni siquiera está mirando.
  // `setBorradorActivo(null)` por el mismo motivo, en la otra direccion: sin
  // esto, un "Usar" un borrador del agente seguido de un "Duplicar"/
  // "Modificar" arrastraria el `borradorId`/`contactId` de un borrador ajeno
  // a esta cotizacion nueva (mismo riesgo que ya resuelve `nuevaCotizacion`
  // para el boton "Nueva cotización", mas abajo).
  useEffect(() => {
    if (!plantilla) return;
    setCliente({ ...CLIENTE_VACIO, ...plantilla.cliente });
    setLineas(plantilla.lineas.map((l) => ({ skuId: l.skuId, cantidadTexto: String(l.cantidad) })));
    setResultado(null);
    setCreado(false);
    setBorradorActivo(null);
    setReemplazaActivo(
      plantilla.reemplazaId
        ? { id: plantilla.reemplazaId, contactId: plantilla.contactId ?? null, numero: plantilla.reemplazaNumero ?? '' }
        : null,
    );
    onPlantillaConsumida?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo debe reaccionar a `plantilla`; `onPlantillaConsumida` no es estable entre renders de Panel.
  }, [plantilla]);

  // La cola de borradores: `/api/cotizacion/borradores` es POST (la sesión
  // por cookie basta) y devuelve solo lo que el agente capturó — sin líneas
  // ni totales, porque nunca los tuvo. Un fallo acá no bloquea la pantalla:
  // el vendedor puede seguir armando cotizaciones a mano aunque la cola no
  // cargue. Ruta de solo lectura: no lleva el token anti-CSRF.
  useEffect(() => {
    let cancelado = false;
    async function cargarBorradores() {
      setCargandoBorradores(true);
      setBorradoresError('');
      try {
        const res = await fetch('/api/cotizacion/borradores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const datos = await res.json();
        if (cancelado) return;
        if (!res.ok || !datos.ok) {
          setBorradoresError(datos.error ?? `Error ${res.status}`);
          return;
        }
        setBorradores(datos.borradores ?? []);
      } catch {
        if (!cancelado) setBorradoresError('Fallo de red.');
      } finally {
        if (!cancelado) setCargandoBorradores(false);
      }
    }
    void cargarBorradores();
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- se pide una sola vez, al montar.
  }, []);

  // Vista previa con rebote de 300ms: cada cambio en las líneas, la tasa de
  // IVA o el bordado especial reinicia el temporizador en vez de disparar una
  // llamada por tecla. `AbortController` corta una respuesta que llegue tarde
  // (p. ej. si el vendedor sigue escribiendo) para que no pise un resultado
  // más nuevo. Ruta de solo lectura: no lleva el token anti-CSRF.
  useEffect(() => {
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
        body: JSON.stringify({ lineas: entradas, tasaIva, bordadoEspecial }),
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
  }, [entradas, tasaIva, bordadoEspecial]);

  // Lo que pidió el dueño de Luxe: después de agregar, lo natural es escribir
  // la cantidad de una — sin este efecto, el campo se monta (inline o en la
  // lista de respaldo) pero el vendedor tiene que ir a buscarlo con el mouse.
  // Corre después de que `agregar()` deja `focoPendiente` con el skuId: para
  // ese momento el input ya está montado (su `ref` corrió durante el commit,
  // antes de que los efectos se disparen), así que `inputsCantidadRef` ya lo
  // tiene registrado.
  useEffect(() => {
    if (!focoPendiente) return;
    const el = inputsCantidadRef.current.get(focoPendiente);
    if (el) {
      el.focus();
      el.select();
    }
    setFocoPendiente(null);
  }, [focoPendiente]);

  // Revisión final (hallazgo importante): antes esta función limpiaba
  // `creado` sin condición, así que un clic en cualquier "Agregar" del
  // catálogo (a un clic de distancia desde que existe el desplegable por
  // familia) reactivaba "Cotizar y enviar" con el mismo cliente todavía
  // cargado — el vendedor terminaba mandando un segundo PDF, con un número
  // de cotización nuevo, al mismo hotel, sin darse cuenta de que ya lo
  // había mandado. Ahora, si la cotización ya se envió, agregar un
  // producto no hace nada: la única forma de volver a habilitar el envío
  // es pedir una cotización nueva de forma explícita (botón "Nueva
  // cotización", que sí limpia todo) — igual que ya vale para `quitar` y
  // `cambiarCantidad`, que nunca tocaron `creado`.
  function agregar(skuId: string) {
    if (creado) return;
    setResultado(null);
    setCreado(false);
    setLineas((prev) => {
      const existente = prev.find((l) => l.skuId === skuId);
      if (!existente) return [...prev, { skuId, cantidadTexto: '1' }];
      const actual = Number.parseInt(existente.cantidadTexto, 10);
      const nueva = Number.isInteger(actual) && actual > 0 ? actual + 1 : 1;
      return prev.map((l) => (l.skuId === skuId ? { ...l, cantidadTexto: String(nueva) } : l));
    });
    // El campo de cantidad se monta ahí mismo, bajo el producto que se
    // acaba de tocar (ver `ItemCatalogo` y el efecto de foco, arriba): no
    // hace falta bajar a buscarlo.
    setFocoPendiente(skuId);
  }

  function cambiarCantidad(skuId: string, texto: string) {
    setLineas((prev) => prev.map((l) => (l.skuId === skuId ? { ...l, cantidadTexto: texto } : l)));
  }

  function quitar(skuId: string) {
    setLineas((prev) => prev.filter((l) => l.skuId !== skuId));
  }

  // Reinicia el formulario para armar una cotización nueva. Es la única
  // forma de volver a habilitar el envío después de uno exitoso — un
  // segundo clic sobre el mismo botón ya no alcanza, a propósito, y
  // (revisión final) tampoco alcanza agregar otro producto: `agregar`,
  // arriba, ahora respeta el mismo criterio en vez de reabrir el envío por
  // su cuenta.
  function nuevaCotizacion() {
    setLineas([]);
    setCliente(CLIENTE_VACIO);
    setBusqueda('');
    setTasaIva(IVA_GENERAL);
    setBordadoEspecial(false);
    setResultado(null);
    setCreado(false);
    setDetalleGhlAbierto(false);
    setCotizacion(COTIZACION_VACIA);
    setPreviaError('');
    // Sin esto, una cotización nueva y sin relación con ningún borrador
    // arrastraría el `borradorId`/`contactId` del borrador anterior y
    // cerraría (o pisaría el contacto de) una fila que no le corresponde.
    setBorradorActivo(null);
    // Mismo motivo, para "Modificar": una cotización nueva armada desde cero
    // (botón "Nueva cotización") no reemplaza nada.
    setReemplazaActivo(null);
  }

  // Convierte un borrador en el punto de partida de una cotización real:
  // rellena los datos del cliente y deja un recordatorio visible con el
  // pedido tal como lo escribió — el vendedor elige los SKUs contra eso, la
  // pantalla no interpreta "unos 300" por su cuenta.
  function usarBorrador(borrador: Borrador) {
    const c = borrador.cliente ?? {};
    setCliente({
      nombre: textoDe(c.nombre),
      empresa: textoDe(c.empresa),
      email: textoDe(c.email),
      // El agente de WhatsApp no captura estos dos: quedan vacíos, igual que
      // en CLIENTE_VACIO, hasta que el vendedor los complete a mano.
      telefono: textoDe(c.telefono),
      direccion: textoDe(c.direccion),
    });
    setRecordatorio({ producto: textoDe(c.producto), cantidadTexto: textoDe(c.cantidadTexto) });
    // Ronda de correcciones 2 (hallazgo I1): antes esto se tiraba —
    // `borrador.id` y `borrador.contact_id` nunca salían de esta función, así
    // que el envío final creaba una fila nueva sin relación con el borrador
    // (que se quedaba abierto para siempre) y, cuando el borrador sí traía
    // contacto, GoHighLevel de todos modos daba de alta uno nuevo.
    setBorradorActivo({ id: borrador.id, contactId: borrador.contact_id });
  }

  const correoValido = cliente.email.trim().length > 0;
  // El servidor (cotizacionSchema en lib/validation.ts) exige `cliente.nombre`
  // igual que exige el correo. El botón tiene que pedir lo mismo que el
  // servidor: si solo revisa el correo, deja enviar y volver con un 400
  // evitable. Ver revisión de la Tarea 8.
  const nombreValido = cliente.nombre.trim().length > 0;
  const puedeCrear =
    !creando &&
    !creado &&
    lineas.length > 0 &&
    !hayLineaInvalida &&
    !hayLineaDescontinuada &&
    correoValido &&
    nombreValido;

  async function crear() {
    if (!puedeCrear) return;
    setCreando(true);
    setResultado(null);
    setDetalleGhlAbierto(false);
    try {
      const csrf = obtenerCsrf();
      const res = await fetch('/api/cotizacion', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Esta ruta escribe: la única credencial que lleva es la cookie
          // de sesión más este token en la cabecera (Fase 3 — ya no hay
          // clave compartida que mandar como respaldo). Sin un token
          // vigente, el servidor responde 401 y `onSesionInvalida()`, más
          // abajo, saca al vendedor de vuelta a la pantalla de acceso para
          // conseguir uno nuevo.
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({
          cliente: {
            nombre: cliente.nombre.trim(),
            empresa: cliente.empresa.trim() || undefined,
            email: cliente.email.trim(),
            // Opcionales (Tarea 5): `undefined` desaparece al pasar por
            // `JSON.stringify`, así que enviarlos vacíos no bloquea la
            // cotización — ver el comentario en `Cliente`, arriba.
            telefono: cliente.telefono.trim() || undefined,
            direccion: cliente.direccion.trim() || undefined,
          },
          lineas: entradas,
          tasaIva,
          bordadoEspecial,
          // Ronda de correcciones 2 (hallazgo I1): solo van si esta
          // cotización nació de un borrador del agente. `borradorId` le
          // dice al servidor qué fila cerrar; `contactId` evita que se dé
          // de alta un contacto nuevo en GoHighLevel para alguien que ya
          // existe ahí. `undefined` desaparece al pasar por
          // `JSON.stringify`, así que una cotización armada desde cero no
          // manda ninguno de los dos.
          borradorId: borradorActivo?.id,
          // "Modificar" (migración 0016): `reemplazaId` sólo va si esta
          // cotización viene de esa acción -- le dice al servidor qué fila
          // vieja marcar 'reemplazada' cuando el envío salga bien. El
          // `contactId` puede venir del reemplazo o del borrador -- nunca
          // los dos a la vez (`reemplazaActivo`/`borradorActivo` se
          // resetean entre sí, ver el efecto de `plantilla` y
          // `nuevaCotizacion` más arriba), así que el orden acá no decide
          // nada en la práctica; se deja `reemplazaActivo` primero por ser
          // el caso más nuevo.
          reemplazaId: reemplazaActivo?.id,
          contactId: reemplazaActivo?.contactId ?? borradorActivo?.contactId ?? undefined,
        }),
      });
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        // Ronda de correcciones 1 (hallazgo crítico): un 401 acá solo puede
        // significar que la cookie y/o el token anti-CSRF ya no valen —esta
        // vista no manda otra credencial—, así que quedarse con el token
        // rancio dejaría al vendedor atrapado: puede seguir leyendo (las
        // rutas de lectura no exigen CSRF) pero nunca volver a escribir.
        // `onSesionInvalida()` limpia el token y vuelve a la pantalla de
        // clave, que es la única forma de conseguir uno vigente.
        if (res.status === 401) onSesionInvalida();
        setResultado({ ok: false, error: datos.error ?? `Error ${res.status}` });
        return;
      }
      setResultado({
        ok: true,
        id: datos.id,
        numero: datos.numero,
        // Defensivos: si el servidor alguna vez respondiera sin estos dos
        // campos, la pantalla no debe reventar — solo perder el detalle.
        pdf: datos.pdf ?? null,
        correo: datos.correo ?? { error: 'El servidor no informó el resultado del envío.' },
        ghlEstimateId: datos.ghl?.estimateId,
        ghlError: datos.ghl?.error,
      });
      // El borrador ya quedó cerrado en el servidor (estado 'convertida'):
      // se saca también de la lista local para que la cola no siga
      // mostrándolo como pendiente hasta la próxima recarga.
      if (borradorActivo) {
        const idCerrado = borradorActivo.id;
        setBorradores((prev) => prev.filter((b) => b.id !== idCerrado));
      }
      // A partir de aquí el pedido ya existe en Supabase (y probablemente en
      // GoHighLevel): `puedeCrear` pasa a false y se queda así hasta que el
      // vendedor pida explícitamente una cotización nueva.
      setCreado(true);
    } catch {
      setResultado({ ok: false, error: 'Fallo de red.' });
    } finally {
      setCreando(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <section className="space-y-6">
        <div className="rounded-xl border border-[var(--carta-border)] bg-[var(--carta-fill)] p-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-teal">Borradores pendientes</h2>
          <p className="mt-1 text-xs text-teal/70">
            Intención capturada por el agente de WhatsApp — no son cotizaciones calculables,
            solo el punto de partida para armar una.
          </p>
          {cargandoBorradores && <p className="mt-3 text-xs text-teal/70">Cargando…</p>}
          {!cargandoBorradores && borradoresError && (
            <p className="mt-3 text-xs text-red-700">{borradoresError}</p>
          )}
          {!cargandoBorradores && !borradoresError && borradores.length === 0 && (
            <p className="mt-3 text-sm text-teal">No hay borradores pendientes.</p>
          )}
          {!cargandoBorradores && borradores.length > 0 && (
            <ul className="mt-3 divide-y divide-[var(--carta-border)]">
              {borradores.map((borrador) => {
                const c = borrador.cliente ?? {};
                const nombre = textoDe(c.nombre) || 'Sin nombre';
                const empresa = textoDe(c.empresa);
                const email = textoDe(c.email) || 'Sin correo';
                const producto = textoDe(c.producto) || 'Producto sin especificar';
                const cantidadTexto = textoDe(c.cantidadTexto) || 'cantidad no indicada';
                return (
                  <li key={borrador.id} className="py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm text-navy">
                          {nombre}
                          {empresa ? ` · ${empresa}` : ''}
                        </p>
                        <p className="text-xs text-teal">{email}</p>
                        <p className="mt-1 text-xs text-navy">
                          {producto} —{' '}
                          {/* No parsear ni redondear esto. "unos 300" no es 300: convertirlo
                              es criterio del vendedor, no del sistema — el agente capturó
                              texto libre, no un número, y esta pantalla no interpreta lo que
                              no puede saber. Ver tests/cotizador-ui.test.tsx, describe
                              "Borradores pendientes (Tarea 10)": el mutante que pasa esta
                              variable por `Number.parseInt` antes de pintarla pone esas
                              pruebas en rojo — no lo "arregles" para que se vea más prolijo. */}
                          <span className="font-medium">«{cantidadTexto}»</span>
                        </p>
                        <p className="mt-1 text-xs text-teal/70">{formatearFecha(borrador.created_at)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => usarBorrador(borrador)}
                        className="shrink-0 rounded-lg border border-[var(--carta-border)] px-3 py-1.5 text-xs font-medium text-navy hover:bg-navy hover:text-beige"
                      >
                        Usar
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {recordatorio && (
          <div className="rounded-xl border border-[var(--carta-border)] bg-[color:var(--carta-border)]/30 p-4 text-sm text-navy">
            El cliente pidió, en sus propias palabras:{' '}
            <span className="font-medium">
              «{recordatorio.cantidadTexto || 'cantidad no indicada'}» de{' '}
              {recordatorio.producto || 'producto sin especificar'}
            </span>
            . Elegí los SKUs contra ese pedido — la cantidad de arriba no está interpretada.
          </div>
        )}

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
            <>
              <p className="mt-3 text-xs text-teal/70">
                Escribí para buscar entre los {skus.length} productos del catálogo, o desplegá una familia para ver
                todo.
              </p>
              <div className="mt-3 space-y-2">
                {familiasCatalogo.map(({ familia, items }) => (
                  <details
                    key={familia}
                    // Una familia con al menos una línea agregada se
                    // mantiene desplegada: es justo ahí donde vive su control
                    // de cantidad (ver `ItemCatalogo`, abajo), y montarlo
                    // dentro de un desplegable cerrado lo dejaría invisible
                    // e imposible de enfocar. Sin líneas, `undefined` deja el
                    // desplegable sin controlar — el vendedor lo abre y
                    // cierra con el mouse o el teclado, como siempre.
                    open={familiasConLineas.has(familia) || undefined}
                    className="group rounded-lg border border-[var(--carta-border)]"
                  >
                    <summary className="cursor-pointer select-none rounded-lg px-3 py-2 text-sm font-medium text-navy hover:bg-[color:var(--carta-border)]/30">
                      {familia} <span className="font-normal text-teal">({items.length})</span>
                    </summary>
                    <ul className="divide-y divide-[var(--carta-border)] border-t border-[var(--carta-border)] px-3">
                      {items.map((sku) => (
                        <ItemCatalogo
                          key={sku.id}
                          sku={sku}
                          linea={lineaPorSkuId.get(sku.id)}
                          calculada={calculadaPorSkuId.get(sku.id)}
                          onAgregar={agregar}
                          onCambiarCantidad={cambiarCantidad}
                          onQuitar={quitar}
                          registrarInputCantidad={registrarInputCantidad}
                        />
                      ))}
                    </ul>
                  </details>
                ))}
              </div>
            </>
          ) : resultadosBusqueda.length === 0 ? (
            <p className="mt-3 text-xs text-teal/70">Sin resultados para «{busqueda}».</p>
          ) : (
            <ul className="mt-3 divide-y divide-[var(--carta-border)]">
              {resultadosBusqueda.map((sku) => (
                <ItemCatalogo
                  key={sku.id}
                  sku={sku}
                  linea={lineaPorSkuId.get(sku.id)}
                  calculada={calculadaPorSkuId.get(sku.id)}
                  onAgregar={agregar}
                  onCambiarCantidad={cambiarCantidad}
                  onQuitar={quitar}
                  registrarInputCantidad={registrarInputCantidad}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-[var(--carta-border)] bg-[var(--carta-fill)] p-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-teal">Líneas de la cotización</h2>
          {/* Ya no es la única forma de ver o editar una línea — desde que
              se agrega, sus controles ya están arriba, en el catálogo o la
              búsqueda (ver `ItemCatalogo`). Esta lista queda como respaldo
              para lo que el catálogo no puede mostrar en su lugar: un
              producto descontinuado, o una línea cuyo producto ya no
              coincide con lo que hay escrito ahora en el buscador
              (`lineasDeRespaldo`, arriba). */}
          {lineas.length === 0 ? (
            <p className="mt-3 text-sm text-teal">Todavía no agregaste ningún producto.</p>
          ) : lineasDeRespaldo.length === 0 ? (
            <p className="mt-3 text-sm text-teal">Todo lo agregado está visible en el catálogo, arriba.</p>
          ) : (
            <ul className="mt-3 divide-y divide-[var(--carta-border)]">
              {lineasDeRespaldo.map((linea) => {
                const sku = porId.get(linea.skuId);
                // Ronda de correcciones 1 (hallazgo importante): antes esta
                // linea desaparecia en silencio (`return null`) cuando el
                // SKU ya no estaba en el catalogo vigente -- tipicamente
                // una cotizacion vieja duplicada cuyo producto se
                // descontinuo despues. El servidor la rechaza igual (400,
                // `calcular` lanza) pero el vendedor no tenia forma de
                // verla ni de quitarla desde acá: la unica salida era
                // abandonar la cotizacion entera. Ahora se pinta marcada,
                // con boton de quitar -- ver `hayLineaDescontinuada`, que
                // bloquea el envio mientras quede alguna.
                if (!sku) {
                  return (
                    <li key={linea.skuId} className="rounded-lg bg-red-50 px-2 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm text-red-800">
                          Producto ya no disponible <span className="font-mono text-xs">({linea.skuId})</span>
                        </p>
                        <button
                          type="button"
                          onClick={() => quitar(linea.skuId)}
                          className="text-xs text-red-800 underline hover:text-red-900"
                        >
                          Quitar
                        </button>
                      </div>
                      <p className="mt-1 text-xs text-red-700">
                        Este producto salió del catálogo. Quitalo para poder cotizar el resto.
                      </p>
                    </li>
                  );
                }
                return (
                  <li key={linea.skuId} className="py-3">
                    <p className="text-sm text-navy">{sku.nombre}</p>
                    <ControlesLinea
                      linea={linea}
                      calculada={calculadaPorSkuId.get(linea.skuId)}
                      onCambiarCantidad={cambiarCantidad}
                      onQuitar={quitar}
                      registrarInputCantidad={registrarInputCantidad}
                    />
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
          {hayLineaDescontinuada && (
            <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
              Hay líneas de productos que ya no están en el catálogo — quitalas para poder
              enviar la cotización.
            </p>
          )}
        </div>
      </section>

      <aside className="space-y-6">
        <div className="rounded-xl border border-[var(--carta-border)] bg-[var(--carta-fill)] p-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-teal">Total cotizado</h2>
          <p className="mt-1 font-display text-3xl text-navy">{formatearColones(cotizacion.total)}</p>
          {previsualizando && <p className="mt-1 text-xs text-teal/70">Calculando…</p>}
          {previaError && (
            <p className="mt-1 text-xs text-red-700">{previaError}</p>
          )}

          {lineas.length > 0 && (
            <dl className="mt-4 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-teal">Subtotal</dt>
                <dd className="text-navy">{formatearColones(cotizacion.subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-teal">Ahorro por descuento</dt>
                <dd className="text-navy">{formatearColones(cotizacion.ahorro)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-teal">IVA ({formatearTasa(cotizacion.tasaIva)}%)</dt>
                <dd className="text-navy">{formatearColones(cotizacion.iva)}</dd>
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
          {/* "Modificar" (migración 0016): el único aviso visible de que esta
              cotización va a reemplazar otra -- sin esto, el formulario se ve
              idéntico a "Duplicar" y el vendedor no tiene forma de confirmar
              que está tocando la fila correcta antes de mandar. El numero es
              el que trajo la plantilla (snapshot del listado); si viniera
              vacío por algún motivo, no se inventa uno. */}
          {reemplazaActivo && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Vas a reemplazar la cotización {reemplazaActivo.numero || 'anterior'}. Al enviar, esa queda
              marcada como reemplazada.
            </p>
          )}
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
              Teléfono (opcional)
              <input
                type="tel"
                aria-label="Teléfono del cliente"
                value={cliente.telefono}
                onChange={(e) => setCliente((c) => ({ ...c, telefono: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-[var(--carta-border)] bg-white px-3 py-2 text-sm text-navy"
              />
            </label>
            <label className="block text-xs text-teal">
              Dirección (opcional)
              <input
                aria-label="Dirección del cliente"
                value={cliente.direccion}
                onChange={(e) => setCliente((c) => ({ ...c, direccion: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-[var(--carta-border)] bg-white px-3 py-2 text-sm text-navy"
              />
            </label>
          </div>

          <button
            type="button"
            onClick={() => void crear()}
            disabled={!puedeCrear}
            className="mt-4 w-full rounded-lg bg-navy px-4 py-2.5 text-sm font-medium text-beige hover:bg-teal disabled:opacity-40"
          >
            {/* Ronda de correcciones 1 (Tarea 5): "Cotizar y enviar" vuelve a ser
                cierto — el clic dispara `crear()`, que guarda la fila, genera el PDF
                y manda el correo con el adjunto al hotel en la misma petición. Antes
                ("final-fix-C") el botón tuvo que dejar de decir "Enviar cotización"
                porque `crearEstimate` (lib/cotizador/ghl.ts) solo creaba un Estimate
                en borrador — nada salía de verdad. Ahora sí sale, así que el texto
                puede volver a prometerlo, en los tres estados: reposo, en vuelo y
                terminado. El detalle de qué salió (o no) vive en el mensaje de abajo,
                no en el botón — un fallo del correo no debe convertir "guardada" en
                mentira. */}
            {creando ? 'Enviando…' : creado ? 'Cotización guardada' : 'Cotizar y enviar'}
          </button>

          {creado && (
            <button
              type="button"
              onClick={nuevaCotizacion}
              className="mt-2 w-full rounded-lg border border-[var(--carta-border)] px-4 py-2.5 text-sm font-medium text-navy hover:bg-navy hover:text-beige"
            >
              Nueva cotización
            </button>
          )}

          {resultado && resultado.ok && (
            <div className="mt-3 rounded-lg bg-[color:var(--carta-border)]/30 px-3 py-2 text-xs text-navy">
              {/* Ronda de correcciones 1 (Tarea 5): antes esta caja solo decía
                  "Cotización guardada" y, aparte, "falta enviarla al cliente — abrila
                  en GoHighLevel y envíala vos desde ahí". Eso invitaba a que el
                  vendedor mandara la misma cotización dos veces, en formatos
                  distintos: una vez sola (el correo con el PDF de Luxe, automático) y
                  otra a mano desde GoHighLevel. Ahora el mensaje principal lee el
                  resultado real del correo (`resultado.correo`) y el del PDF
                  (`resultado.pdf`), en vez de asumir que "guardada" alcanza. */}
              {'resendId' in resultado.correo ? (
                <p>
                  Cotización {resultado.numero ? `${resultado.numero} ` : ''}
                  enviada a <strong>{cliente.email.trim()}</strong>, con el PDF adjunto.
                </p>
              ) : resultado.pdf ? (
                <p className="rounded-lg bg-red-50 px-2 py-1.5 text-red-800">
                  La cotización se guardó, pero el correo no salió: {resultado.correo.error}.
                  El PDF quedó guardado — se puede reenviar a mano.
                </p>
              ) : (
                <p className="rounded-lg bg-red-50 px-2 py-1.5 text-red-800">
                  No se pudo generar el PDF: no se envió nada al cliente. La cotización
                  quedó guardada y es recuperable.
                </p>
              )}
              {/* GoHighLevel queda como una línea secundaria, informativa — ya no es
                  el envío real, así que no lleva instrucciones de mandar nada a mano. */}
              {resultado.ghlEstimateId ? (
                <p className="mt-1 text-teal">GoHighLevel: Estimate {resultado.ghlEstimateId} creado.</p>
              ) : resultado.ghlError ? (
                // Revisión final (hallazgo menor, M2): antes acá se pintaba
                // `GoHighLevel: {resultado.ghlError}` en crudo -- la
                // respuesta tal cual la mandó GoHighLevel, en inglés, a
                // veces con JSON adentro. Mismo criterio que `AvisoError`
                // en VistaListado.tsx: un aviso humano primero, y el texto
                // crudo detrás de un botón, no a la vista sin pedirlo.
                <p className="mt-1 text-xs font-medium text-amber-700">
                  No se avisó al CRM (GoHighLevel).{' '}
                  <button
                    type="button"
                    onClick={() => setDetalleGhlAbierto((v) => !v)}
                    aria-expanded={detalleGhlAbierto}
                    aria-controls="ghl-error-detalle"
                    className="font-normal underline decoration-dotted underline-offset-2 hover:text-navy"
                  >
                    {detalleGhlAbierto ? 'ocultar detalle' : 'ver detalle'}
                  </button>
                  {detalleGhlAbierto && (
                    <span
                      id="ghl-error-detalle"
                      className="mt-1 block whitespace-pre-wrap break-words text-[11px] font-normal text-teal/70"
                    >
                      {resultado.ghlError}
                    </span>
                  )}
                </p>
              ) : null}
            </div>
          )}
          {resultado && !resultado.ok && (
            <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">{resultado.error}</p>
          )}
        </div>
      </aside>
    </div>
  );
}
