'use client';

import { useEffect, useState } from 'react';
import { PantallaClave } from './PantallaClave';
import { VistaCrear } from './VistaCrear';

// Lo único que el vendedor necesita para buscar y elegir un SKU. Nada de
// `precioLista` ni `grupo`: eso es la lista de precios de Luxe, y esta forma
// es la que de verdad viaja al navegador (la sirve `/api/cotizacion/catalogo`,
// tras clave). Ver Tarea 8. Exportado: `VistaCrear` lo necesita para tipar el
// catálogo que recibe por props.
export type SkuUI = { id: string; nombre: string; familia: string };

type Pestana = 'crear' | 'cotizaciones' | 'metricas';

// El token anti-CSRF (Tarea 6/9) se guarda acá, nunca en una variable de
// React: solo lo entrega la respuesta de `/api/cotizacion/entrar` (y, desde
// la ronda de correcciones 1, también `/api/cotizacion/catalogo` cuando la
// cookie de la petición es válida — ver ese archivo; no depende de CÓMO se
// autenticó la petición, solo de que la cookie lo sea). Si viviera en
// memoria, cada recarga del iframe de GoHighLevel lo perdería — la cookie de
// sesión seguiría viva (dura 30 días), pero sin el token ninguna petición
// que escribe podría pasar el chequeo anti-CSRF, y el vendedor tendría que
// volver a escribir la clave solo para conseguir uno nuevo. `sessionStorage`
// sobrevive a una recarga dentro de la misma pestaña, que es el caso más
// común, aunque no el único — ver el comentario de la sonda, más abajo,
// sobre por qué esto solo no bastaba.
//
// Exportado para pruebas: `tests/cotizador-ui.test.tsx` necesita leer y
// preparar este valor sin duplicar el literal.
export const CSRF_STORAGE_KEY = 'luxe-cotizador-csrf';

function guardarCsrf(csrf: string) {
  try {
    sessionStorage.setItem(CSRF_STORAGE_KEY, csrf);
  } catch {
    // `sessionStorage` puede no estar disponible (modo privado agresivo,
    // política de cookies del iframe, etc.). Sin el token, las peticiones
    // que escriben simplemente no llevan la cabecera y el servidor cae de
    // vuelta en la vía de la clave si todavía la tiene — no hay nada más
    // que hacer acá.
  }
}

function obtenerCsrf(): string | null {
  try {
    return sessionStorage.getItem(CSRF_STORAGE_KEY);
  } catch {
    return null;
  }
}

function limpiarCsrf() {
  try {
    sessionStorage.removeItem(CSRF_STORAGE_KEY);
  } catch {
    // Nada que limpiar si no hay storage que valga.
  }
}

const MENSAJE_SESION_VENCIDA =
  'Tu sesión venció. Volvé a entrar — lo que armaste sigue acá, no se perdió.';

export default function Panel() {
  // Ronda de correcciones 2 (hallazgo importante): `dentro` ya NO significa
  // "sesión válida ahora mismo" — significa "el catálogo se cargó alguna
  // vez, así que `VistaCrear` puede existir". Una vez en `true`, se queda
  // así para siempre; ver `onSesionInvalida` más abajo para por qué.
  const [dentro, setDentro] = useState(false);
  // Controla la pantalla de clave: visible al principio (`dentro` todavía
  // en `false`) y de nuevo cuando la sesión vence a mitad de una
  // cotización. Distinto de `dentro` a propósito — ver el hallazgo 1 de la
  // ronda de correcciones 2.
  const [pidiendoClave, setPidiendoClave] = useState(true);
  // Por qué se está pidiendo la clave, cuando no es la primera vez. `null`
  // en la primera entrada (no hace falta explicar nada todavía).
  const [mensajePantallaClave, setMensajePantallaClave] = useState<string | null>(null);
  const [skus, setSkus] = useState<SkuUI[]>([]);
  // La clave escrita al entrar por formulario. Se guarda en memoria (no en
  // `sessionStorage`, a diferencia del token anti-CSRF): perderla en una
  // recarga es aceptable —la sesión por cookie es la que evita pedirla de
  // nuevo— y no es un secreto que valga la pena persistir aparte. Queda
  // vacía cuando se entra por la sonda de sesión (sin clave conocida).
  const [clave, setClave] = useState('');
  const [pestana, setPestana] = useState<Pestana>('crear');

  // Requisito 3 (Tarea 9): si la sesión ya está viva al montar —cookie
  // válida de una entrada anterior—, no hay que pedir la clave otra vez. Se
  // prueba con una lectura real (`/api/cotizacion/catalogo` sin clave,
  // apoyada solo en la cookie): si responde bien, se entra directo. Si no
  // —sin cookie, cookie vencida, o sin red—, la pantalla de clave sigue
  // siendo la que ya se pinta por defecto; no hace falta un estado de carga
  // aparte.
  //
  // Ronda de correcciones 1 (hallazgo crítico): esta sonda ANTES solo se
  // disparaba si ya había un token guardado en `sessionStorage` — pensado
  // como una señal barata de "esta pestaña ya entró alguna vez". El
  // problema: `sessionStorage` es por pestaña y se borra al cerrarla, pero
  // la cookie dura 30 días y sobrevive a cerrar el navegador entero. Con
  // ese gate, una pestaña nueva (link del menú de GoHighLevel, navegador
  // reabierto) con la cookie todavía viva igual pedía la clave — exactamente
  // el problema que esta sesión existe para resolver, en la mitad de los
  // casos reales. Ahora la sonda se dispara siempre, sin condición: es
  // barata (un solo POST, que además ya hacía falta para saber qué SKUs
  // mostrar) y en una visita realmente nueva —sin cookie— simplemente
  // responde 401 y no cambia nada, igual que antes.
  useEffect(() => {
    let cancelado = false;
    async function probarSesion() {
      try {
        const res = await fetch('/api/cotizacion/catalogo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const datos = await res.json();
        if (cancelado || !res.ok || !datos.ok) return;
        setSkus(datos.skus);
        setDentro(true);
        setPidiendoClave(false);
        // Esta respuesta trae el token anti-CSRF derivado de la cookie que
        // acaba de demostrarse válida (ver app/api/cotizacion/catalogo/route.ts):
        // guardarlo acá repara `sessionStorage` en cualquier pestaña donde
        // la sonda entra por cookie sin haber pasado por `/entrar` en esta
        // misma pestaña — el caso que el gate viejo dejaba sin resolver.
        if (typeof datos.csrf === 'string') guardarCsrf(datos.csrf);
      } catch {
        // Sin sesión viva (o sin red): se queda en la pantalla de clave,
        // igual que si nunca se hubiera intentado.
      }
    }
    void probarSesion();
    return () => {
      cancelado = true;
    };
  }, []);

  // Cambia la clave por una cookie de sesión más un token anti-CSRF
  // (`/api/cotizacion/entrar`, Tarea 6). Nunca lanza: sus tres ramas de
  // fallo (status no-ok, respuesta sin `csrf`, excepción de red) se
  // registran con `console.error` y devuelven sin más — el llamador
  // (`onEntrar`, abajo) decide qué hacer con eso.
  async function establecerSesion(claveIngresada: string) {
    try {
      const res = await fetch('/api/cotizacion/entrar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clave: claveIngresada }),
      });
      if (!res.ok) {
        console.error('[cotizador] No se pudo establecer la sesión por cookie.', res.status);
        return;
      }
      const datos = await res.json();
      if (datos.ok && typeof datos.csrf === 'string') {
        guardarCsrf(datos.csrf);
      } else {
        console.error('[cotizador] /entrar respondió sin token anti-CSRF.');
      }
    } catch (e) {
      console.error(
        '[cotizador] No se pudo establecer la sesión por cookie (fallo de red).',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // Ronda de correcciones 1 (hallazgo crítico) — Ronda de correcciones 2
  // (hallazgo importante, cierra el problema que dejó abierto la 1): si el
  // token guardado quedó rancio (segunda pestaña que rotó la cookie, o
  // simplemente venció) el envío final vuelve con 401. `VistaCrear` llama a
  // esto para pedir la clave de nuevo — pero YA NO desmonta la vista: antes
  // esto ponía `dentro = false`, y como `Panel` solo renderizaba
  // `VistaCrear` cuando `dentro` era `true`, React desmontaba el subárbol
  // entero (cliente, líneas, todo lo armado) en el mismo instante en que
  // `crear()` intentaba pintar el error en él — el vendedor se encontraba
  // con un formulario de clave en blanco, sin explicación, y el trabajo
  // perdido. Ahora `dentro` no se toca: `VistaCrear` sigue montada (con su
  // estado intacto) y `pidiendoClave` la tapa con la pantalla de clave,
  // con un mensaje que dice qué pasó. Al reautenticarse, `onEntrar` solo
  // baja `pidiendoClave` — la cotización a medio armar sigue exactamente
  // donde estaba.
  function onSesionInvalida() {
    limpiarCsrf();
    setClave('');
    setMensajePantallaClave(MENSAJE_SESION_VENCIDA);
    setPidiendoClave(true);
  }

  // La pantalla de clave: sin ella no hay catálogo. `/api/cotizacion/catalogo`
  // es quien valida la clave y quien decide qué SKUs bajan al navegador (sin
  // precios). Al estilo de app/q7m4/Taller.tsx.
  async function onEntrar(claveIngresada: string): Promise<string | null> {
    try {
      const res = await fetch('/api/cotizacion/catalogo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clave: claveIngresada }),
      });
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        return res.status === 401 ? 'Clave incorrecta.' : (datos.error ?? `Error ${res.status}`);
      }
      // Ronda de correcciones 2 (hallazgo importante): antes esta llamada
      // se disparaba sin esperarla, para no demorar la entrada. Pero
      // `crear()` (VistaCrear.tsx) ya no manda la clave en el cuerpo desde
      // la ronda anterior — depende enteramente de que esta sesión ya esté
      // establecida. Sin esperar, el primer envío podía ganarle la carrera
      // a esta llamada y volver con un 401 evitable. Se espera acá: nunca
      // lanza (ver su propio try/catch), así que no puede dejar al
      // vendedor afuera si falla — solo demora unos cientos de ms el
      // "Entrando…" para que, en el camino feliz, el token ya esté listo
      // antes del primer clic en "Cotizar y enviar".
      await establecerSesion(claveIngresada);
      setSkus(datos.skus);
      setClave(claveIngresada);
      setDentro(true);
      setPidiendoClave(false);
      setMensajePantallaClave(null);
      return null;
    } catch {
      return 'Fallo de red.';
    }
  }

  return (
    <>
      {dentro && (
        <main
          className="mx-auto max-w-6xl px-4 py-6 sm:px-6"
          // Ronda de correcciones 2: mientras la pantalla de clave está
          // encima (sesión vencida a mitad de trabajo), este contenido
          // sigue montado —preserva `VistaCrear`— pero queda inerte: sin
          // foco, sin clics, y fuera del árbol de accesibilidad, para que
          // no compita con el formulario que sí hay que llenar.
          aria-hidden={pidiendoClave || undefined}
          // eslint-disable-next-line react/no-unknown-property -- atributo HTML estándar; React 19 lo pasa tal cual al DOM.
          inert={pidiendoClave || undefined}
        >
          <header className="border-b border-[var(--carta-border)] pb-4">
            <h1 className="font-display text-xl text-navy">Cotizador</h1>
            <p className="text-xs text-teal">
              Armá la cotización por SKU. Los precios y descuentos los calcula el mismo motor que
              usa el servidor — lo que ves acá es exactamente lo que va a facturarse.
            </p>
          </header>

          {/* Tres pestañas (Tarea 9): solo "Crear" tiene contenido hoy —lo que ya
              existía en Cotizador.tsx—. "Cotizaciones" y "Métricas" quedan como
              marcadores; se llenan en las próximas dos tareas. */}
          <nav className="mt-4 flex gap-4 border-b border-[var(--carta-border)]" aria-label="Secciones del panel">
            {(
              [
                ['crear', 'Crear'],
                ['cotizaciones', 'Cotizaciones'],
                ['metricas', 'Métricas'],
              ] as const
            ).map(([valor, etiqueta]) => (
              <button
                key={valor}
                type="button"
                onClick={() => setPestana(valor)}
                aria-current={pestana === valor}
                className={`-mb-px border-b-2 px-1 pb-2 text-sm font-medium ${
                  pestana === valor ? 'border-navy text-navy' : 'border-transparent text-teal hover:text-navy'
                }`}
              >
                {etiqueta}
              </button>
            ))}
          </nav>

          <div className="mt-6">
            {pestana === 'crear' && (
              <VistaCrear
                skus={skus}
                clave={clave}
                obtenerCsrf={obtenerCsrf}
                onSesionInvalida={onSesionInvalida}
              />
            )}
            {pestana === 'cotizaciones' && (
              <p className="text-sm text-teal">Cotizaciones — disponible en la próxima tarea.</p>
            )}
            {pestana === 'metricas' && (
              <p className="text-sm text-teal">Métricas — disponible en la próxima tarea.</p>
            )}
          </div>
        </main>
      )}
      {pidiendoClave && (
        // Ronda de correcciones 2 (hallazgo importante): sin este `fixed`
        // (superpuesto, no reemplazando), volver a pedir la clave a mitad
        // de una cotización se llevaría puesto el trabajo de abajo — ver el
        // comentario de `onSesionInvalida`. En la primera entrada (`dentro`
        // todavía en `false`) no hay nada debajo que tapar: se ve igual que
        // antes, solo que con este mismo contenedor.
        <div className="fixed inset-0 z-50 overflow-y-auto bg-navy/50 backdrop-blur-sm">
          <PantallaClave onEntrar={onEntrar} mensaje={mensajePantallaClave ?? undefined} />
        </div>
      )}
    </>
  );
}
