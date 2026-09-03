'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { DescuentoPersonalizado, LineaEntrada } from '@/lib/cotizador/tipos';
import type { PrefillCotizacion } from './Panel';
import { formatearColones, formatearDescuentoPersonalizado, formatearEspera } from './formato';

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
// 'reemplazada' (migración 0016): la cotización vieja que "Modificar" dejó
// atrás -- ver ESTADOS_MODIFICABLES, más abajo, y el comentario grande en
// app/api/cotizacion/route.ts para el criterio completo.
// 'esperando_aprobacion'/'rechazada' (fase 5, descuento con aprobación): ver
// docs/superpowers/specs/2026-09-02-descuento-aprobacion-design.md y la
// migración 0017.
type Estado =
  | 'borrador'
  | 'creada'
  | 'enviada'
  | 'convertida'
  | 'ganada'
  | 'perdida'
  | 'error'
  | 'reemplazada'
  | 'esperando_aprobacion'
  | 'rechazada';

// Fase 5: ninguna de las dos tiene nada que un vendedor haya mandado al
// hotel -- 'esperando_aprobacion' porque el servidor corta ANTES de tocar
// GoHighLevel/PDF/correo (ver app/api/cotizacion/route.ts), 'rechazada'
// porque nunca pasó de ahí. "Ganada"/"Perdida" no tienen sentido sobre una
// fila que nunca salió -- se ocultan junto a Reenviar/Modificar (ver más
// abajo, que ya quedan afuera solos por no tener `pdf_ruta` ni estar en
// `ESTADOS_MODIFICABLES`).
const ESTADOS_SIN_CIERRE: Estado[] = ['esperando_aprobacion', 'rechazada'];

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
  correo_error: string | null;
  // Quién armó la cotización. Se guarda el nombre, no una llave foránea al
  // usuario (ver app/api/cotizacion/route.ts) — así una cotización de hace
  // un año sigue diciendo quién la hizo aunque esa persona ya no exista en
  // el sistema. Las filas anteriores a esta fase quedan en null a
  // propósito: no se inventa un nombre para ellas, se muestra un guion.
  vendedor: string | null;
  // "Modificar" (migración 0016): el rastro entre dos filas, ya resuelto a
  // numero por el servidor (ver el comentario en
  // app/api/cotizacion/listado/route.ts). En la fila nueva, a cuál
  // reemplaza; en la vieja, cuál la reemplazó. A lo sumo uno de los dos es
  // no nulo en una fila dada -- salvo que esa fila haya sido, en algún
  // momento, tanto el resultado de un "Modificar" como el blanco de otro
  // "Modificar" posterior (una cadena de reemplazos, caso raro pero válido).
  reemplaza_a_numero: string | null;
  reemplazada_por_numero: string | null;
  // Fase 5 (descuento con aprobación, migración 0017): sólo pobladas en las
  // filas que pidieron un descuento fuera de escala. `descuento_aprobado`
  // es lo único que distingue, en una fila ya resuelta, si el superadmin
  // aprobó tal cual o cambió el porcentaje -- ver el comentario en
  // app/api/cotizacion/listado/route.ts.
  descuento_personalizado: DescuentoPersonalizado | null;
  solicitado_por: string | null;
  aprobado_por: string | null;
  resuelto_at: string | null;
  motivo_rechazo: string | null;
  descuento_aprobado: DescuentoPersonalizado | null;
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
// 'reemplazada' tampoco: dejó de ser la vigente, la fila nueva es la que
// puede vencer.
const ESTADOS_ABIERTOS: Estado[] = ['creada', 'enviada', 'error'];

// "Modificar" (migración 0016): sobre qué estados aparece la opción en el
// menú. Mismo criterio (y mismo par de estados) que `ESTADOS_MODIFICABLES`
// en app/api/cotizacion/route.ts -- duplicado acá porque esta pantalla no
// puede importar código del servidor (mismo motivo que `DIAS_VIGENCIA`,
// arriba). Ocultar la opción cuando no aplica es sólo cosmético: el
// servidor vuelve a validar el estado real al recibir el envío final, así
// que esto no es la protección de verdad, es evitar ofrecerle al vendedor
// un botón que el servidor va a rechazar seguro.
const ESTADOS_MODIFICABLES: Estado[] = ['creada', 'enviada'];

// Revisión final (hallazgo menor): `vencida` se calcula aparte de
// `diasRestantes`, directo sobre los milisegundos, y no derivándola de
// `diasRestantes < 0`. `Math.ceil` de una diferencia negativa pero de
// menos de un día (vencida hace unas horas, no un día entero) da `-0` --
// una rareza de JavaScript (`Math.ceil(-0.5) === -0`). `-0 < 0` es
// `false`, así que quien confiaba en esa comparación para pintar "vencida"
// dejaba pasar justo esos casos, y una cotización vencida ayer se mostraba
// como si venciera HOY. `vencida` no tiene ese problema: compara los dos
// timestamps directamente, sin pasar por un redondeo a días que pueda
// perder el signo.
type Vigencia = { vence: Date; diasRestantes: number; vencida: boolean; proximaAVencer: boolean };

function calcularVigencia(fila: FilaListado, ahora: Date): Vigencia {
  const vence = new Date(fila.created_at);
  vence.setDate(vence.getDate() + DIAS_VIGENCIA);
  const diasRestantes = Math.ceil((vence.getTime() - ahora.getTime()) / (24 * 60 * 60 * 1000));
  const vencida = vence.getTime() < ahora.getTime();
  const proximaAVencer = ESTADOS_ABIERTOS.includes(fila.estado) && diasRestantes <= DIAS_AVISO_VENCIMIENTO;
  return { vence, diasRestantes, vencida, proximaAVencer };
}

const ETIQUETAS_ESTADO: Record<Estado, string> = {
  borrador: 'Borrador',
  creada: 'Creada',
  enviada: 'Enviada',
  convertida: 'Convertida',
  ganada: 'Ganada',
  perdida: 'Perdida',
  error: 'Error',
  reemplazada: 'Reemplazada',
  esperando_aprobacion: 'Esperando aprobación',
  rechazada: 'Rechazada',
};

// Colores por estado (Paso 3 del brief): sin respuesta en neutro, ganada en
// verde, perdida en gris, error en rojo. El resto (borrador/convertida, que
// casi nunca aparecen acá) cae en el mismo neutro que "sin respuesta".
//
// Fase 5: 'esperando_aprobacion' en ámbar -- mismo criterio que "vencida"
// en VistaEquipo.tsx: necesita que alguien la mire, no es ni un éxito ni un
// fallo todavía. 'rechazada' en rojo, mismo peso visual que 'error' -- las
// dos son "esta cotización no llegó al cliente", aunque por motivos
// distintos (uno es una decisión, el otro un fallo técnico); el texto de la
// píldora ya distingue cuál es cuál.
function estiloEstado(estado: Estado): string {
  switch (estado) {
    case 'ganada':
      return 'bg-emerald-100 text-emerald-800';
    case 'perdida':
    // "Modificar": mismo gris neutro que 'perdida' -- ninguna de las dos es
    // un fallo (rojo) ni un éxito (verde), es una fila que dejó de estar
    // activa.
    case 'reemplazada':
      return 'bg-gray-200 text-gray-700';
    case 'error':
    case 'rechazada':
      return 'bg-red-100 text-red-800';
    case 'esperando_aprobacion':
      return 'bg-amber-100 text-amber-800';
    default:
      return 'bg-[color:var(--carta-border)]/50 text-navy';
  }
}

// Ronda de correcciones 2 (hallazgo del dueño): antes, `ghl_error` se
// volcaba tal cual en la fila -- la respuesta cruda del servidor de
// GoHighLevel, en inglés, con JSON adentro, ocupando varios renglones. Le
// servía a quien depura y no le decía nada a un vendedor. La regla de la
// fase 1 de este proyecto sigue de pie: un fallo no puede desaparecer del
// todo (ver el comentario junto a `correo_error`, más abajo, en la fila) --
// así que el texto crudo no se borra, se mueve detrás de un control que se
// abre con el mouse o con el teclado (`<button aria-expanded>`, sin
// dependencias nuevas). `resumen` es la frase en español que necesita el
// vendedor; `detalle` es la respuesta tal cual la mandó el servidor, para
// quien tenga que depurarla.
type TonoAviso = 'critico' | 'aviso';

function AvisoError({
  id,
  resumen,
  detalle,
  tono,
  abierto,
  onToggle,
}: {
  id: string;
  resumen: string;
  detalle: string;
  tono: TonoAviso;
  abierto: boolean;
  onToggle: () => void;
}) {
  // 'critico': el cliente se quedó sin la cotización (correo_error) -- el
  // mismo rojo que ya usa la píldora "Error". 'aviso': la cotización salió
  // bien, lo que falló es el aviso al CRM (ghl_error) -- el mismo ámbar que
  // ya usa el resto de la pantalla para "salió, pero con algo pendiente"
  // (ver el mensaje de /reenviar más abajo). Ningún color nuevo.
  const color = tono === 'critico' ? 'text-red-700' : 'text-amber-700';
  return (
    <div className="mt-1 max-w-[16rem]">
      <p className={`text-xs font-medium ${color}`}>
        {resumen}{' '}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={abierto}
          aria-controls={id}
          // Revisión final (hallazgo menor): este botón llevaba
          // `title={detalle}` -- el rediseño sacó el volcado crudo del
          // cuerpo de la fila, pero lo dejó en un atributo. Un vendedor que
          // pasara el mouse por encima veía el JSON igual, sin hacer clic
          // en "ver detalle", y ninguna prueba lo detectaba porque
          // `queryByText` no mira atributos. El detalle ya se pinta como
          // texto, abajo, cuando `abierto` es true -- no hace falta
          // repetirlo en un tooltip que se ve sin pedirlo.
          className="font-normal underline decoration-dotted underline-offset-2 hover:text-navy"
        >
          {abierto ? 'ocultar detalle' : 'ver detalle'}
        </button>
      </p>
      {abierto && (
        <p id={id} className="mt-1 whitespace-pre-wrap break-words text-[11px] text-teal/70">
          {detalle}
        </p>
      )}
    </div>
  );
}

// Hallazgo del dueño: seis controles por fila (Ganada, Perdida, Ver PDF,
// Reenviar, Duplicar, Ver en GoHighLevel) ocupaban más espacio que los
// datos de la cotización. `ITEM_MENU` describe las cuatro que se recogen
// detrás de un botón de tres puntos por fila: son apoyo situacional (revisar
// un PDF ya mandado, reenviarlo, duplicar la cotización, saltar a la ficha
// del contacto en el CRM) -- ninguna es algo que un vendedor haga con cada
// fila que mira. "Ganada" y "Perdida" NO entran acá a propósito: son la
// decisión que un vendedor toma con la mayor frecuencia al repasar su
// listado -- es la razón de ser de esta pantalla -- y enterrarla a dos
// clics (abrir el menú, después elegir) cambiaría un problema de saturación
// por uno de fricción en lo que más se usa. Se quedan como botones sólidos,
// igual que antes.
type ItemMenu =
  | { tipo: 'boton'; etiqueta: string; disabled?: boolean; onClick: () => void }
  | { tipo: 'enlace'; etiqueta: string; href: string };

// El menú se porta a `document.body` (posición `fixed`, calculada a mano
// con `getBoundingClientRect`) en vez de `absolute` dentro de la fila. La
// tabla ya vive en un contenedor con `overflow-x-auto` (ver más abajo, en
// VistaListado) -- y por cómo funciona `overflow` en CSS, fijar solo el eje
// X ahí convierte el eje Y en `auto` también, aunque nadie lo haya pedido.
// Un menú `absolute` dentro de esa fila quedaría recortado contra el borde
// inferior del contenedor en vez de flotar sobre la tabla. `fixed` fuera de
// ese árbol no tiene ese problema, y en el iframe angosto de GoHighLevel
// (el otro riesgo real acá) `ubicar()` recalcula el lado en el que cae el
// menú para que no se corte contra el borde derecho de la ventana.
function MenuAcciones({
  id,
  etiqueta,
  abierto,
  onAbrir,
  onCerrar,
  items,
}: {
  id: string;
  etiqueta: string;
  abierto: boolean;
  onAbrir: () => void;
  onCerrar: () => void;
  items: ItemMenu[];
}) {
  const botonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [posicion, setPosicion] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!abierto) return;
    const ANCHO_MENU = 208; // Ancho fijo (ver className del menú, abajo) -- se necesita antes de pintarlo para calcular dónde cae.
    const MARGEN = 8;
    function ubicar() {
      const boton = botonRef.current;
      if (!boton) return;
      const rect = boton.getBoundingClientRect();
      // Por defecto el borde derecho del menú se alinea con el del botón
      // (cuelga hacia la izquierda, como es habitual). Si eso lo saca por
      // el borde izquierdo de la ventana, se alinea por la izquierda del
      // botón en su lugar; si ninguna de las dos alcanza (columna muy
      // angosta), se pega al margen mínimo.
      let left = rect.right - ANCHO_MENU;
      if (left < MARGEN) left = rect.left;
      if (left + ANCHO_MENU > window.innerWidth - MARGEN) left = window.innerWidth - ANCHO_MENU - MARGEN;
      if (left < MARGEN) left = MARGEN;
      setPosicion({ top: rect.bottom + 4, left });
    }
    ubicar();
    window.addEventListener('resize', ubicar);
    window.addEventListener('scroll', ubicar, true);
    return () => {
      window.removeEventListener('resize', ubicar);
      window.removeEventListener('scroll', ubicar, true);
    };
  }, [abierto]);

  // Foco inicial en el primer ítem habilitado: quien abre con Enter/Espacio
  // ya puede navegar con flechas sin un Tab de más. `enfocado` evita
  // repetirlo en cada recálculo de `posicion` (scroll/resize) mientras el
  // menú sigue abierto -- sin ese resguardo, un scroll a mitad de la
  // navegación con flechas le robaría el foco de vuelta al primer ítem.
  // Depende de `posicion` (no solo de `abierto`) porque el menú recién
  // existe en el DOM -- vía el portal, más abajo -- una vez que `posicion`
  // deja de ser `null`; enfocar un ítem que todavía no se pintó no hace
  // nada.
  const enfocadoRef = useRef(false);
  useEffect(() => {
    if (!abierto) {
      enfocadoRef.current = false;
      return;
    }
    if (enfocadoRef.current || !posicion) return;
    enfocadoRef.current = true;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [abierto, posicion]);

  // Clic afuera cierra. `mousedown`, no `click` -- así se adelanta al clic
  // que podría estar abriendo OTRO menú (el botón de otra fila): si fuera
  // `click`, ese mismo evento cerraría este Y dispararía el `onClick` que
  // abre el otro, en el mismo ciclo, sin pelearse -- pero da la casualidad
  // de que funciona por eso, no a propósito. `mousedown` lo evita de raíz.
  useEffect(() => {
    if (!abierto) return;
    function alPulsar(e: MouseEvent) {
      const objetivo = e.target as Node;
      if (botonRef.current?.contains(objetivo) || menuRef.current?.contains(objetivo)) return;
      onCerrar();
    }
    document.addEventListener('mousedown', alPulsar);
    return () => document.removeEventListener('mousedown', alPulsar);
  }, [abierto, onCerrar]);

  // Escape cierra y devuelve el foco al botón -- que el vendedor no pierda
  // su lugar en la tabla. Flechas/Home/End navegan entre ítems, como se
  // espera de un `role="menu"`. Tab también cierra: el foco de todas formas
  // se va del menú, y no tiene sentido dejarlo abierto flotando sin nada
  // enfocado adentro.
  function alTeclado(e: KeyboardEvent<HTMLDivElement>) {
    const habilitados = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    const actual = habilitados.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      onCerrar();
      botonRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      habilitados[(actual + 1) % habilitados.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      habilitados[(actual - 1 + habilitados.length) % habilitados.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      habilitados[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      habilitados[habilitados.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      onCerrar();
    }
  }

  return (
    <>
      <button
        ref={botonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={abierto}
        aria-controls={id}
        aria-label={etiqueta}
        onClick={() => (abierto ? onCerrar() : onAbrir())}
        className="rounded-lg border border-[var(--carta-border)] px-2 py-1 text-sm leading-none text-navy hover:bg-navy hover:text-beige"
      >
        ⋯
      </button>
      {abierto &&
        posicion &&
        createPortal(
          <div
            ref={menuRef}
            id={id}
            role="menu"
            aria-label={etiqueta}
            onKeyDown={alTeclado}
            style={{ position: 'fixed', top: posicion.top, left: posicion.left, width: 208 }}
            className="z-50 overflow-hidden rounded-lg border border-[var(--carta-border)] bg-white py-1 text-sm shadow-lg"
          >
            {items.map((item, i) =>
              item.tipo === 'enlace' ? (
                <a
                  key={i}
                  role="menuitem"
                  href={item.href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={onCerrar}
                  className="block px-3 py-1.5 text-navy hover:bg-[var(--carta-fill)]"
                >
                  {item.etiqueta}
                </a>
              ) : (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    onCerrar();
                    item.onClick();
                  }}
                  className="block w-full px-3 py-1.5 text-left text-navy hover:bg-[var(--carta-fill)] disabled:opacity-40"
                >
                  {item.etiqueta}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
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
  // Fase 5 (descuento con aprobación): para que un vendedor pueda revisar
  // sus propias solicitudes sin tener que ser superadmin ni entrar a la
  // pestaña "Aprobaciones" (que ni siquiera ve) -- acá sólo filtra, no
  // aprueba ni rechaza nada.
  { valor: 'esperando_aprobacion', etiqueta: 'Esperando aprobación' },
  { valor: 'rechazada', etiqueta: 'Rechazada' },
];

type Props = {
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
  // Tarea 11: "Ver en el listado" desde la pestaña Métricas (bloque de
  // fallidas) llega pidiendo un filtro ya aplicado. Se lee una sola vez, al
  // montar: esta vista se remonta entera cada vez que se entra a la pestaña
  // (ver el `{pestana === 'cotizaciones' && ...}` en Panel.tsx), así que no
  // hace falta re-sincronizar después — y `onFiltroInicialConsumido` le
  // avisa a `Panel` que ya se aplicó, para que un cambio de pestaña normal
  // (clic en "Cotizaciones", sin pasar por Métricas) no vuelva a filtrar por
  // error solo. Mismo patrón que `plantilla`/`onPlantillaConsumida`.
  filtroInicial?: string;
  onFiltroInicialConsumido?: () => void;
};

export function VistaListado({
  obtenerCsrf,
  onSesionInvalida,
  onDuplicar,
  filtroInicial,
  onFiltroInicialConsumido,
}: Props) {
  const [cotizaciones, setCotizaciones] = useState<FilaListado[] | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  const [filtroEstado, setFiltroEstado] = useState(filtroInicial ?? '');
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

  // Qué detalle técnico (ghl_error/correo_error) está desplegado ahora
  // mismo, por fila -- ver `AvisoError`. Colapsado por defecto: el texto
  // crudo del servidor no está a la vista mientras nadie pida verlo.
  const [detallesAbiertos, setDetallesAbiertos] = useState<Record<string, boolean>>({});
  function alternarDetalle(clave: string) {
    setDetallesAbiertos((d) => ({ ...d, [clave]: !d[clave] }));
  }

  // Qué fila tiene el menú de acciones (Ver PDF/Reenviar/Duplicar/Ver en
  // GoHighLevel) desplegado ahora mismo. Una fila a la vez, mismo criterio
  // que `procesandoId`: abrir otro cierra el anterior solo con sobreescribir
  // este valor.
  const [menuAbiertoId, setMenuAbiertoId] = useState<string | null>(null);

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
        body: JSON.stringify(estadoParaServidor ? { estado: estadoParaServidor } : {}),
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
    setMenuAbiertoId(null);
    void cargar(filtroEstado, () => cancelado);
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- se pide de nuevo cada vez que cambia el filtro, no en cada render.
  }, [filtroEstado]);

  // Tarea 11: le avisa a `Panel` que el filtro que trajo desde "Métricas"
  // ya se aplicó (quedó adentro de `filtroEstado`, arriba), para que la
  // próxima vez que se entre a esta pestaña por el camino normal —el botón
  // "Cotizaciones"— no vuelva a filtrar por error solo. Se dispara una sola
  // vez, al montar: es a propósito que no dependa de `filtroInicial`.
  useEffect(() => {
    if (filtroInicial) onFiltroInicialConsumido?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al montar.
  }, []);

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

  // Ronda de correcciones final (hallazgo importante): la única acción del
  // diseño que nunca se construyó. Antes de esto, la única forma de ver un
  // PDF ya guardado era reenviárselo al cliente — cuando un hotel llama
  // preguntando por su cotización, el vendedor no tenía forma de abrirla.
  // `/api/cotizacion/pdf` firma el enlace de un PDF que ya existe en
  // Storage; acá solo se abre en una pestaña nueva.
  async function verPdf(fila: FilaListado) {
    setProcesandoId(fila.id);
    try {
      const res = await fetch('/api/cotizacion/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: fila.id }),
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
      window.open(datos.url, '_blank', 'noopener,noreferrer');
    } catch {
      setMensajesFila((m) => ({ ...m, [fila.id]: { tipo: 'error', texto: 'Fallo de red.' } }));
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
        body: JSON.stringify({ id: fila.id }),
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

  // "Modificar" (migración 0016): mismo camino que "Duplicar" -- reutiliza
  // la misma ruta de solo lectura (`/api/cotizacion/duplicar`, que ya trae
  // exactamente lo que hace falta: `skuId`/`cantidad` por línea, sin
  // precios) porque "Modificar" es "Duplicar" más tres cosas, y las tres
  // viajan en el payload que arma esta función, no en la ruta que lee las
  // líneas:
  //   1. reutilizar el contacto: `contactId: fila.contact_id`.
  //   2. enlazar las dos filas: `reemplazaId: fila.id`.
  //   3. marcar la vieja: eso lo hace el servidor, al final del envío, sólo
  //      si sale bien (`app/api/cotizacion/route.ts`) -- acá no se marca
  //      nada todavía. Abrir "Modificar" y no enviar no debe dejar rastro.
  async function modificar(fila: FilaListado) {
    setProcesandoId(fila.id);
    try {
      const res = await fetch('/api/cotizacion/duplicar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: fila.id }),
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
        reemplazaId: fila.id,
        reemplazaNumero: fila.numero ?? undefined,
        contactId: fila.contact_id ?? undefined,
      });
    } catch {
      setMensajesFila((m) => ({ ...m, [fila.id]: { tipo: 'error', texto: 'Fallo de red.' } }));
    } finally {
      setProcesandoId(null);
    }
  }

  // Fase 5 (descuento con aprobación): "cancelar" es lo único que el diseño
  // le permite hacer al vendedor con una cotización que quedó esperando --
  // no puede editarla en el lugar (ver
  // docs/superpowers/specs/2026-09-02-descuento-aprobacion-design.md). La
  // fila vuelve a 'borrador' (lib/cotizador/aprobacion.ts, `cancelar`) --
  // editable de nuevo vía "Duplicar", que ya está disponible sobre
  // cualquier estado.
  async function cancelarSolicitud(fila: FilaListado) {
    setProcesandoId(fila.id);
    try {
      const csrf = obtenerCsrf();
      const res = await fetch('/api/cotizacion/cancelar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Regla de seguridad 1: /cancelar escribe, exige el token anti-CSRF.
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({ id: fila.id }),
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
      setMensajesFila((m) => ({ ...m, [fila.id]: { tipo: 'ok', texto: 'Solicitud cancelada.' } }));
      await cargar(filtroEstado);
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
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead className="bg-[var(--carta-fill)] text-xs uppercase tracking-wide text-teal">
              <tr>
                <th className="px-3 py-2 min-w-[11rem]">Cliente</th>
                <th className="px-3 py-2">Número</th>
                <th className="px-3 py-2">Vendedor</th>
                <th className="px-3 py-2">Fecha</th>
                <th className="px-3 py-2">Vigencia</th>
                <th className="px-3 py-2 text-right">Monto</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2 min-w-[13rem]">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--carta-border)]">
              {filasVisibles.map((fila) => {
                const { vence, diasRestantes, vencida, proximaAVencer } = calcularVigencia(fila, new Date());
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
                    <td className="px-3 py-3 align-top">
                      <p className="whitespace-nowrap text-navy">{nombre}</p>
                      {empresa && <p className="whitespace-nowrap text-xs text-teal">{empresa}</p>}
                    </td>
                    <td className="px-3 py-3 align-top text-navy">{fila.numero ?? '—'}</td>
                    <td className="px-3 py-3 align-top text-teal">{fila.vendedor || '—'}</td>
                    <td className="px-3 py-3 align-top text-xs text-teal/70">{formatearFecha(fila.created_at)}</td>
                    <td className="px-3 py-3 align-top">
                      {proximaAVencer ? (
                        <span
                          className={`font-semibold tabular-nums ${vencida ? 'text-red-700' : 'text-amber-700'}`}
                        >
                          {vencida
                            ? `Vencida hace ${Math.abs(diasRestantes)} día(s)`
                            : diasRestantes === 0
                              ? 'Vence hoy'
                              : `Vence en ${diasRestantes} día(s)`}
                        </span>
                      ) : (
                        <span className="text-xs text-teal/80">{formatearFecha(vence.toISOString())}</span>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top text-right font-semibold tabular-nums text-navy">
                      {formatearColones(monto)}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${estiloEstado(fila.estado)}`}>
                        {ETIQUETAS_ESTADO[fila.estado] ?? fila.estado}
                      </span>
                      {/* Ronda de correcciones final (hallazgo importante): el
                          diseño promete "las que fallaron, con su error" —
                          antes esta píldora era todo lo que se veía, sin el
                          motivo de fondo. `correo_error` (persistido recién,
                          ver app/api/cotizacion/route.ts) explica por qué no
                          llegó al cliente -- el fallo más grave de los dos:
                          la cotización no le llegó a nadie. */}
                      {fila.estado === 'error' && fila.correo_error && (
                        <AvisoError
                          id={`correo-error-${fila.id}`}
                          resumen="No le llegó el correo al cliente."
                          detalle={fila.correo_error}
                          tono="critico"
                          abierto={!!detallesAbiertos[`correo:${fila.id}`]}
                          onToggle={() => alternarDetalle(`correo:${fila.id}`)}
                        />
                      )}
                      {fila.motivo_cierre && (
                        <p className="mt-1 max-w-[16rem] text-xs text-teal">{fila.motivo_cierre}</p>
                      )}
                      {/* `ghl_error`: la cotización sí salió -- lo que falló
                          es nada más el aviso al CRM. No es el mismo fallo
                          que `correo_error` y no debe verse igual (ver
                          `AvisoError`, arriba en el archivo). */}
                      {fila.ghl_error && (
                        <AvisoError
                          id={`ghl-error-${fila.id}`}
                          resumen="No se avisó al CRM (GoHighLevel)."
                          detalle={fila.ghl_error}
                          tono="aviso"
                          abierto={!!detallesAbiertos[`ghl:${fila.id}`]}
                          onToggle={() => alternarDetalle(`ghl:${fila.id}`)}
                        />
                      )}
                      {/* "Modificar" (migración 0016): el rastro entre dos
                          filas, con el número de cotización -- lo que el
                          cliente cita por teléfono, no un id. En la fila
                          vieja (reemplazada), a quién le cedió el lugar; en
                          la nueva, a cuál reemplazó. */}
                      {fila.reemplazada_por_numero && (
                        <p className="mt-1 text-xs text-teal">
                          Reemplazada por {fila.reemplazada_por_numero}.
                        </p>
                      )}
                      {fila.reemplaza_a_numero && (
                        <p className="mt-1 text-xs text-teal">Reemplaza a {fila.reemplaza_a_numero}.</p>
                      )}
                      {/* Fase 5: el descuento pedido, quién lo pidió, y (si
                          ya se resolvió) el desenlace -- lo mismo que ya
                          muestra VistaAprobaciones, sólo que acá convive con
                          el resto del historial de la fila, así que se
                          condensa en un par de líneas de texto en vez de
                          tarjetas propias. */}
                      {fila.descuento_personalizado && fila.estado === 'esperando_aprobacion' && (
                        <p className="mt-1 max-w-[16rem] text-xs text-amber-800">
                          Pedido: {formatearDescuentoPersonalizado(fila.descuento_personalizado)}
                          {fila.solicitado_por ? ` (por ${fila.solicitado_por})` : ''} -- esperando hace{' '}
                          {formatearEspera(fila.created_at)}.
                        </p>
                      )}
                      {fila.estado === 'rechazada' && (
                        <p className="mt-1 max-w-[16rem] text-xs text-red-700">
                          {fila.motivo_rechazo ? `Motivo: ${fila.motivo_rechazo}. ` : ''}
                          {fila.descuento_personalizado
                            ? `Pedido: ${formatearDescuentoPersonalizado(fila.descuento_personalizado)}. `
                            : ''}
                          {fila.aprobado_por ? `Rechazada por ${fila.aprobado_por}.` : ''}
                        </p>
                      )}
                      {fila.descuento_aprobado &&
                        fila.descuento_personalizado &&
                        fila.estado !== 'esperando_aprobacion' &&
                        fila.estado !== 'rechazada' && (
                          <p className="mt-1 max-w-[16rem] text-xs text-teal">
                            Descuento aprobado: {formatearDescuentoPersonalizado(fila.descuento_aprobado)}
                            {fila.aprobado_por ? ` (por ${fila.aprobado_por})` : ''}.
                          </p>
                        )}
                    </td>
                    <td className="px-3 py-3 align-top">
                      {/* Jerarquía de acciones (hallazgo del dueño): seis
                          controles por fila ocupaban más espacio que los
                          datos de la cotización. "Ganada"/"Perdida" son la
                          decisión que un vendedor toma con más frecuencia al
                          repasar su listado -- la razón de ser de esta
                          pantalla -- y quedan afuera del menú, como botones
                          sólidos, para no cambiar saturación por fricción en
                          lo más usado. El resto (revisar el PDF, reenviar,
                          duplicar, saltar al CRM) es apoyo situacional: se
                          recoge detrás del botón de tres puntos, ver
                          `MenuAcciones` más arriba en el archivo.

                          Fase 5: ninguna de las dos aplica sobre
                          'esperando_aprobacion'/'rechazada' -- ver
                          ESTADOS_SIN_CIERRE, arriba en el archivo: nada de
                          eso salió al hotel todavía, así que no hay nada
                          que marcar ganado o perdido. */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        {!ESTADOS_SIN_CIERRE.includes(fila.estado) && (
                          <>
                            <button
                              type="button"
                              disabled={enProceso}
                              onClick={() => void cerrar(fila.id, 'ganada')}
                              className="rounded-lg bg-navy px-2.5 py-1 text-xs font-medium text-beige hover:bg-navy/90 disabled:opacity-40"
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
                              className="rounded-lg border border-[var(--carta-border)] px-2.5 py-1 text-xs font-medium text-navy hover:bg-navy hover:text-beige disabled:opacity-40"
                            >
                              Perdida
                            </button>
                          </>
                        )}
                        <MenuAcciones
                          id={`menu-acciones-${fila.id}`}
                          etiqueta={`Más acciones para ${nombre}`}
                          abierto={menuAbiertoId === fila.id}
                          onAbrir={() => setMenuAbiertoId(fila.id)}
                          onCerrar={() => setMenuAbiertoId(null)}
                          items={[
                            ...(fila.pdf_ruta
                              ? [
                                  {
                                    tipo: 'boton' as const,
                                    etiqueta: 'Ver PDF',
                                    disabled: enProceso,
                                    onClick: () => void verPdf(fila),
                                  },
                                ]
                              : []),
                            // "Modificar" (migración 0016): "Reenviar" ahora
                            // depende de dos condiciones, no una sola --
                            // `pdf_ruta` (siempre) Y que la fila no esté ya
                            // 'reemplazada' (mandarle al hotel un PDF con un
                            // precio que ya no vale es peor que no reenviar
                            // nada; el servidor también lo rechaza, esto es
                            // sólo para no ofrecer el botón). "Ver PDF"
                            // arriba NO lleva esta segunda condición a
                            // propósito: revisar el PDF viejo de una fila ya
                            // reemplazada sigue siendo útil e inofensivo.
                            ...(fila.pdf_ruta && fila.estado !== 'reemplazada'
                              ? [
                                  {
                                    tipo: 'boton' as const,
                                    etiqueta: 'Reenviar',
                                    disabled: enProceso,
                                    onClick: () => void reenviar(fila.id),
                                  },
                                ]
                              : []),
                            {
                              tipo: 'boton' as const,
                              etiqueta: 'Duplicar',
                              disabled: enProceso,
                              onClick: () => void duplicar(fila),
                            },
                            // "Modificar" (migración 0016): sólo sobre las
                            // dos formas de "hay un precio en pie" -- ver
                            // ESTADOS_MODIFICABLES, arriba en el archivo.
                            ...(ESTADOS_MODIFICABLES.includes(fila.estado)
                              ? [
                                  {
                                    tipo: 'boton' as const,
                                    etiqueta: 'Modificar',
                                    disabled: enProceso,
                                    onClick: () => void modificar(fila),
                                  },
                                ]
                              : []),
                            ...(fila.contact_id && locationId
                              ? [
                                  {
                                    tipo: 'enlace' as const,
                                    etiqueta: 'Ver en GoHighLevel',
                                    href: `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${fila.contact_id}`,
                                  },
                                ]
                              : []),
                            // Fase 5: "cancelar" es lo único que el diseño
                            // le permite hacer al vendedor con una
                            // solicitud que sigue esperando -- sólo sobre
                            // 'esperando_aprobacion', nunca sobre una ya
                            // resuelta.
                            ...(fila.estado === 'esperando_aprobacion'
                              ? [
                                  {
                                    tipo: 'boton' as const,
                                    etiqueta: 'Cancelar solicitud',
                                    disabled: enProceso,
                                    onClick: () => void cancelarSolicitud(fila),
                                  },
                                ]
                              : []),
                          ]}
                        />
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
