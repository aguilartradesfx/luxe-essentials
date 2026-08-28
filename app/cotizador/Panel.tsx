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
// entrada fue por cookie — ver ese archivo). Si viviera en memoria, cada
// recarga del iframe de GoHighLevel lo perdería — la cookie de sesión
// seguiría viva (dura 30 días), pero sin el token ninguna petición que
// escribe podría pasar el chequeo anti-CSRF, y el vendedor tendría que
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

export default function Panel() {
  const [dentro, setDentro] = useState(false);
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
  // (`/api/cotizacion/entrar`, Tarea 6). Es "best-effort" y no bloquea la
  // entrada: la clave que ya se validó contra `/catalogo` abajo sigue
  // siendo una vía de autenticación válida por sí sola para las rutas de
  // lectura (lib/autenticacion-cotizador.ts), así que un fallo acá (red,
  // cookies bloqueadas) no debe dejar al vendedor fuera de la pantalla. Lo
  // que sí puede fallar en silencio si esto falla es el envío final
  // (`VistaCrear.crear()`, que ya no manda la clave en el cuerpo — ver ese
  // archivo): por eso el `console.error`, para que el síntoma ("no puedo
  // cotizar") tenga un rastro distinguible de un simple fallo de red del
  // vendedor.
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

  // Ronda de correcciones 1 (hallazgo crítico): si el token guardado quedó
  // rancio —por ejemplo, se abrió una segunda pestaña y volvió a entrar,
  // rotando la cookie y el csrf que le corresponde, mientras esta pestaña
  // seguía con el viejo— el envío final vuelve con 401 y, sin esto, el
  // vendedor quedaba atrapado: `dentro` nunca volvía a `false` por sí solo,
  // así que el panel seguía leyendo (las rutas de lectura no exigen CSRF)
  // pero nunca podía volver a escribir. `VistaCrear` llama a esto cuando
  // `crear()` recibe 401: se limpia el token inservible y se vuelve a la
  // pantalla de clave, que es la única forma de conseguir uno vigente.
  function onSesionInvalida() {
    limpiarCsrf();
    setClave('');
    setDentro(false);
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
      setSkus(datos.skus);
      setClave(claveIngresada);
      setDentro(true);
      // No se espera esta llamada: obtener la sesión por cookie no debe
      // demorar la entrada a la pantalla principal.
      void establecerSesion(claveIngresada);
      return null;
    } catch {
      return 'Fallo de red.';
    }
  }

  if (!dentro) {
    return <PantallaClave onEntrar={onEntrar} />;
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
  );
}
