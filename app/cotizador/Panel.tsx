'use client';

import { useEffect, useState } from 'react';
import type { LineaEntrada } from '@/lib/cotizador/tipos';
import { PantallaClave } from './PantallaClave';
import { VistaAprobaciones } from './VistaAprobaciones';
import { VistaCrear } from './VistaCrear';
import { VistaEquipo } from './VistaEquipo';
import { VistaListado } from './VistaListado';
import { VistaMetricas } from './VistaMetricas';

// Mismo motivo que la duplicación de `Estado` en VistaListado.tsx: `Rol`
// vive en lib/cotizador/usuarios.ts, que arranca con `import 'server-only'`
// — un componente de cliente no puede importarlo. Se repite acá el mismo par
// de valores ('vendedor' | 'superadmin' — ver ROLES en ese archivo).
type Rol = 'vendedor' | 'superadmin';

// Lo único que el vendedor necesita para buscar y elegir un SKU. Nada de
// `precioLista` ni `grupo`: eso es la lista de precios de Luxe, y esta forma
// es la que de verdad viaja al navegador (la sirve `/api/cotizacion/catalogo`,
// tras sesión). Ver Tarea 8. Exportado: `VistaCrear` lo necesita para tipar el
// catálogo que recibe por props.
export type SkuUI = { id: string; nombre: string; familia: string };

// Tarea 10: lo que deja "Duplicar" en `VistaListado` para que `VistaCrear`
// arranque con eso precargado, en vez de en blanco. `lineas` son solo
// `skuId`/`cantidad` —nunca precios: los recalcula el servidor de nuevo,
// con la lista vigente hoy (ver app/api/cotizacion/duplicar/route.ts)—.
// Exportado: lo usan tanto `VistaListado` (quien lo arma) como `VistaCrear`
// (quien lo consume).
export type PrefillCotizacion = {
  cliente: { nombre: string; empresa: string; email: string; telefono: string; direccion: string };
  lineas: LineaEntrada[];
  // "Modificar" (migración 0016): sólo van cuando esta plantilla viene de
  // esa acción, no de "Duplicar" a secas. `reemplazaId` es el id de la
  // cotización vieja -- viaja hasta el envío final para que el servidor la
  // marque 'reemplazada' recién cuando la nueva sale de verdad (ver
  // app/api/cotizacion/route.ts). `contactId` es el contacto de GoHighLevel
  // de esa cotización vieja, para reutilizarlo en vez de dar de alta uno
  // nuevo. `reemplazaNumero` es sólo para mostrarle al vendedor, en
  // `VistaCrear`, a cuál está por reemplazar -- el servidor nunca confía en
  // este valor (relee el numero real de la fila vieja al procesar el envío).
  reemplazaId?: string;
  reemplazaNumero?: string;
  contactId?: string;
};

type Pestana = 'crear' | 'cotizaciones' | 'metricas' | 'equipo' | 'aprobaciones';

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
    // que escriben simplemente no llevan la cabecera y el servidor las
    // rechaza con 401 — desde la Fase 3 no hay ninguna otra vía: no hay
    // nada más que hacer acá.
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
  // A quién pertenece la sesión — se muestra en la cabecera ("Sesión de
  // Guillermo Rojas") para que sea visible con qué cuenta se está
  // trabajando. Llega en la respuesta de `/entrar` la primera vez, y en la
  // de `/api/cotizacion/catalogo` en cada recarga (la cookie es `HttpOnly`,
  // así que `Panel` no puede leerla directo para saber de quién es).
  // `null` hasta que alguna de las dos respuestas lo entregue.
  const [vendedor, setVendedor] = useState<string | null>(null);
  // Tarea 6: qué rol tiene quien está adentro. Sólo controla si la pestaña
  // "Equipo" se DIBUJA (ver el comentario, más abajo, junto a la pestaña) —
  // no protege nada por sí mismo. `null` hasta que `/entrar` o `/catalogo`
  // lo entreguen, igual que `vendedor`.
  const [rol, setRol] = useState<Rol | null>(null);
  const [pestana, setPestana] = useState<Pestana>('crear');
  // Tarea 10 ("Duplicar"): lo que precarga en `VistaCrear`. `VistaListado`
  // no decide nada más — arma el dato y lo manda para acá; `Panel` decide
  // qué hacer con él (cambiar a la pestaña "Crear"). Ronda de correcciones
  // 1: `VistaCrear` ya NO se desmonta al cambiar de pestaña (ver el `div
  // hidden` más abajo), así que esto ya no es un valor inicial de una sola
  // vez — `VistaCrear` reacciona a cada cambio de esta referencia con un
  // `useEffect`, y por eso `onPlantillaConsumida` (abajo) la vuelve a
  // `null` después de aplicada: sin eso, un futuro cambio de pestaña no
  // volvería a disparar el efecto (la referencia sería la misma), pero
  // tampoco queremos que sobreviva para reaplicarse sola más adelante.
  const [plantilla, setPlantilla] = useState<PrefillCotizacion | null>(null);
  // Tarea 11: el filtro con el que "Ver en el listado" (bloque de fallidas,
  // en Métricas) quiere que arranque la pestaña "Cotizaciones". Vacío en el
  // caso normal —se entra a esa pestaña por su propio botón, sin filtro
  // pedido—. `VistaListado` lo consume una sola vez, al montar, y avisa por
  // `onFiltroInicialConsumido` para que un cambio de pestaña posterior (el
  // botón "Cotizaciones", no el enlace de fallidas) no vuelva a filtrar por
  // error solo. Mismo patrón que `plantilla`/`onPlantillaConsumida`.
  const [filtroListadoInicial, setFiltroListadoInicial] = useState('');

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
        // Tarea 5 (usuarios del panel): esta respuesta también trae el
        // nombre del vendedor dueño de la cookie — sin esto, un refresco
        // dejaría el panel con sesión pero sin saber de quién es (el nombre
        // solo llega, si no, en la respuesta de `/entrar`, que ocurre una
        // sola vez).
        if (typeof datos.vendedor === 'string') setVendedor(datos.vendedor);
        // Tarea 6: mismo motivo — un refresco de página no debe perder de
        // vista si quien está adentro es superadmin o vendedor.
        if (datos.rol === 'vendedor' || datos.rol === 'superadmin') setRol(datos.rol);
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

  // Cambia el usuario y la clave por una cookie de sesión más un token
  // anti-CSRF (`/api/cotizacion/entrar`, Tarea 6), y de paso trae el
  // catálogo — desde la Fase 3 ninguna otra ruta lo sirve sin cookie válida.
  // Nunca lanza: cualquier rama de fallo (credenciales rechazadas, cookie
  // que no llegó a fijarse, excepción de red) vuelve como `{ ok: false,
  // error }`; el llamador (`onEntrar`, abajo) decide qué hacer con eso.
  //
  // Tarea 5 (usuarios del panel), reescrito: hasta la Tarea 4 esta función
  // era un best-effort — si la verificación de abajo fallaba, solo dejaba un
  // `console.error` y seguía, porque las tres rutas que escriben también
  // aceptaban la clave compartida en el cuerpo como respaldo. Esa vía ya no
  // existe (`autenticarPeticion`, lib/autenticacion-cotizador.ts, solo mira
  // la cookie): un panel que "entra" sin cookie real detrás quedaría
  // leyendo, sin poder guardar nada, sin decírselo a nadie — el peor modo de
  // fallo posible. Por eso ahora la verificación GATEA la entrada: si no se
  // puede confirmar que la cookie de verdad cuajó en este navegador, esta
  // función devuelve el error y `onEntrar` no deja pasar al vendedor.
  //
  // La verificación en sí no cambió de mecanismo: un 200 de `/entrar` solo
  // prueba que el servidor INTENTÓ fijar la cookie (mandó `Set-Cookie` en la
  // respuesta) — no que el navegador la aceptó. La cookie es `HttpOnly`: este
  // código no puede leerla directo para comprobarlo, y dentro de un iframe
  // real de GoHighLevel (`SameSite=None` + `Partitioned`) nada garantiza que
  // el navegador la conserve. Por eso se hace una lectura real, apoyada solo
  // en la cookie (`/api/cotizacion/catalogo`, mismo endpoint que usa la
  // sonda de sesión al montar): si el servidor la valida, la cookie de
  // verdad llegó, y esa misma respuesta trae el catálogo, el token anti-CSRF
  // y el vendedor.
  //
  // Ronda de correcciones 1 (Tarea 5, hallazgo menor) — acoplamiento a tener
  // en cuenta: la condición de abajo exige `typeof datosVerificacion.csrf ===
  // 'string'`, y `/api/cotizacion/catalogo` retiene el `csrf` a propósito
  // cuando la petición llega con `Sec-Fetch-Site: cross-site` (ver ese
  // archivo). Antes de esta tarea esa combinación sólo significaba "no
  // guardo token"; desde acá también significa "no entrás", con este mismo
  // mensaje de iframe. Hoy no es alcanzable — este `fetch` sale del propio
  // documento del panel y viaja como `same-origin` —, pero quien toque ese
  // endurecimiento anti-CSRF más adelante debe saber que ahora también es la
  // puerta de entrada, no sólo una protección de la sesión ya abierta.
  async function establecerSesion(
    correo: string,
    claveIngresada: string,
  ): Promise<
    { ok: true; skus: SkuUI[]; vendedor: string; rol: Rol } | { ok: false; error: string }
  > {
    try {
      const res = await fetch('/api/cotizacion/entrar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ correo, clave: claveIngresada }),
      });
      const datos = await res.json().catch(() => null);
      if (!res.ok || !datos?.ok) {
        return { ok: false, error: datos?.error ?? `Error ${res.status}` };
      }

      const verificacion = await fetch('/api/cotizacion/catalogo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const datosVerificacion = await verificacion.json().catch(() => null);
      if (!verificacion.ok || !datosVerificacion?.ok || typeof datosVerificacion.csrf !== 'string') {
        return {
          ok: false,
          error:
            'No pudimos abrir tu sesión en este navegador. Si estás viendo el panel dentro de ' +
            'Bralto, abrilo en una pestaña aparte.',
        };
      }
      guardarCsrf(datosVerificacion.csrf);
      // Ronda de correcciones 1 (Tarea 5, hallazgo menor): tanto `datos`
      // (`/entrar`) como `datosVerificacion` (`/catalogo`) llegan como `any`
      // — sin este guard explícito, un `vendedor` ausente en las dos
      // respuestas colaría `undefined` en un campo tipado `string`. Hoy es
      // inocuo (`{vendedor && …}` en el render no pinta nada con `''`), pero
      // el tipo no debe mentir.
      const vendedor =
        typeof datosVerificacion.vendedor === 'string'
          ? datosVerificacion.vendedor
          : typeof datos.vendedor === 'string'
            ? datos.vendedor
            : '';
      // Tarea 6: mismo guard que `vendedor`, mismo motivo. Si por lo que sea
      // ninguna de las dos respuestas trae un rol reconocible, se cae al
      // menos privilegiado ('vendedor') — esto sólo decide si se DIBUJA la
      // pestaña "Equipo" (ver el comentario junto a ella), así que fallar
      // hacia el lado que oculta de más es lo seguro.
      const rol: Rol =
        datosVerificacion.rol === 'superadmin' || datosVerificacion.rol === 'vendedor'
          ? datosVerificacion.rol
          : datos.rol === 'superadmin' || datos.rol === 'vendedor'
            ? datos.rol
            : 'vendedor';
      return { ok: true, skus: datosVerificacion.skus, vendedor, rol };
    } catch (e) {
      console.error(
        '[cotizador] No se pudo establecer la sesión por cookie (fallo de red).',
        e instanceof Error ? e.message : String(e),
      );
      return { ok: false, error: 'Fallo de red.' };
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
    setMensajePantallaClave(MENSAJE_SESION_VENCIDA);
    setPidiendoClave(true);
  }

  // Revisión final, Importante 3: "Salir". Sin esto, en una computadora
  // compartida —la recepción, la oficina— el segundo vendedor no tenía forma
  // de dejar de ser el primero: la cookie dura 30 días y es `HttpOnly`, así
  // que ni siquiera se podía borrar desde acá. Sus cotizaciones quedaban
  // firmadas con el nombre equivocado, de forma permanente e indistinguible.
  //
  // El servidor caduca la cookie (`/api/cotizacion/salir`); acá se limpia el
  // token anti-CSRF guardado y se devuelve la pantalla de acceso. `dentro` NO
  // se toca, por el mismo motivo que en `onSesionInvalida`: la pantalla de
  // clave se superpone y `VistaCrear` sigue montada. Lo que sí se borra es el
  // vendedor — dejar el nombre anterior pintado detrás del formulario sería
  // decirle a quien va a entrar que la sesión de la otra persona sigue viva.
  //
  // Si el `fetch` falla (sin red), igual se pide la clave: no dejar salir
  // porque la red está caída es el peor de los dos errores. El servidor
  // seguirá aceptando esa cookie hasta que venza — eso se documenta en el
  // README junto al procedimiento de dar de baja a alguien.
  async function onSalir() {
    try {
      await fetch('/api/cotizacion/salir', { method: 'POST' });
    } catch (e) {
      console.error(
        '[cotizador] No se pudo cerrar la sesión en el servidor (fallo de red).',
        e instanceof Error ? e.message : String(e),
      );
    }
    limpiarCsrf();
    setVendedor(null);
    // Tarea 6: mismo motivo que `setVendedor(null)` — dejar el rol de la
    // persona anterior pintado (aunque sea solo para dibujar una pestaña)
    // sería otro resto de su sesión sobreviviendo a "Salir".
    setRol(null);
    setMensajePantallaClave(null);
    setPidiendoClave(true);
  }

  // "Duplicar" (Tarea 10) y "Modificar" (migración 0016): las dos le pasan
  // a esta misma función el mismo tipo de dato (`VistaListado` ya lo
  // resolvió -- cliente + líneas, sin precios, y para "Modificar" también
  // `reemplazaId`/`reemplazaNumero`/`contactId`); acá no hay que
  // distinguirlas -- solo se guarda para el próximo montaje de `VistaCrear`
  // (que sí reacciona distinto según venga o no `reemplazaId`, ver su
  // efecto sobre `plantilla`) y se salta a la pestaña "Crear".
  function onDuplicar(datos: PrefillCotizacion) {
    setPlantilla(datos);
    setPestana('crear');
  }

  // "Ver en el listado" (Tarea 11, bloque de fallidas en Métricas): salta a
  // la pestaña "Cotizaciones" con el filtro ya en 'error'. Es el único
  // camino que hoy saca esas cotizaciones a la luz.
  function onVerFallidas() {
    setFiltroListadoInicial('error');
    setPestana('cotizaciones');
  }

  // `VistaCrear` llama a esto una sola vez, al montar, si arrancó con una
  // plantilla — para que un futuro remonte de la pestaña "Crear" (volver
  // sin haber duplicado de nuevo) no reaplique una plantilla vieja.
  function onPlantillaConsumida() {
    setPlantilla(null);
  }

  // La pantalla de acceso: sin usuario y clave válidos no hay catálogo.
  // `establecerSesion` (arriba) hace todo el trabajo — autentica, verifica
  // que la cookie haya cuajado en este navegador y trae el catálogo—; acá
  // solo se traduce ese resultado a estado de React. Al estilo de
  // app/q7m4/Taller.tsx.
  async function onEntrar(correo: string, claveIngresada: string): Promise<string | null> {
    const resultado = await establecerSesion(correo, claveIngresada);
    if (!resultado.ok) return resultado.error;
    setSkus(resultado.skus);
    setVendedor(resultado.vendedor);
    setRol(resultado.rol);
    setDentro(true);
    setPidiendoClave(false);
    setMensajePantallaClave(null);
    return null;
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
            {/* Tarea 5 (usuarios del panel): antes había una sola clave compartida
                para todo el equipo, así que no había con qué llenar esto. Ahora
                cada vendedor entra con su propia cuenta — mostrar de quién es la
                sesión hace visible con qué credencial se está trabajando.
                Revisión final (Importante 3): "Salir" va justo al lado, porque
                el momento en que alguien lee de quién es la sesión es el mismo
                en que descubre que no es la suya. */}
            {vendedor && (
              <p className="mt-1 flex items-center gap-2 text-xs text-teal">
                <span>Sesión de {vendedor}</span>
                <button
                  type="button"
                  onClick={onSalir}
                  className="underline underline-offset-2 hover:text-navy"
                >
                  Salir
                </button>
              </p>
            )}
          </header>

          {/* Tres pestañas (Tarea 9): solo "Crear" tiene contenido hoy —lo que ya
              existía en Cotizador.tsx—. "Cotizaciones" y "Métricas" quedan como
              marcadores; se llenan en las próximas dos tareas.

              Tarea 6: se suma "Equipo", pero SOLO en esta lista si `rol` es
              'superadmin' — es decir, sólo se DIBUJA el botón. Esto es
              cosmético, no una protección: quien manipule el estado de React
              de este componente (o llame a las rutas directo) no gana nada,
              porque las cuatro rutas de app/api/equipo/* releen la fila de
              quien hace la petición en la base antes de actuar
              (`autorizarSuperadmin`, lib/cotizador/equipo.ts) — nunca
              confían en este `rol`, que sale de la cookie y puede estar
              desactualizado hasta 30 días (ver el comentario de `establecerSesion`,
              arriba). Ocultar el botón es sólo para no ofrecerle a un
              vendedor una pestaña que el servidor le va a rechazar con 403
              de todas formas.

              Fase 5 (descuento con aprobación): "Aprobaciones" se suma con el
              MISMO criterio, cosmético de la misma forma -- las tres rutas
              de app/api/cotizacion/{pendientes,aprobar,rechazar}/route.ts
              releen la fila de quien pide con `autorizarSuperadmin`, igual
              que /api/equipo/*, y devuelven 403 a quien no es superadmin de
              verdad ahora mismo. */}
          <nav className="mt-4 flex gap-4 border-b border-[var(--carta-border)]" aria-label="Secciones del panel">
            {(
              [
                ['crear', 'Crear'],
                ['cotizaciones', 'Cotizaciones'],
                ['metricas', 'Métricas'],
                ...(rol === 'superadmin'
                  ? ([
                      ['equipo', 'Equipo'],
                      ['aprobaciones', 'Aprobaciones'],
                    ] as [Pestana, string][])
                  : []),
              ] as [Pestana, string][]
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
            {/* Ronda de correcciones 1 (hallazgo importante): `VistaCrear`
                YA NO se desmonta al salir de esta pestaña. Antes vivía
                detrás de `{pestana === 'crear' && (...)}`, igual que las
                otras dos — pero esta es la única de las tres que puede
                tener trabajo del vendedor a medio hacer (cliente tecleado,
                líneas elegidas) que nada persiste en ningún lado. Con esa
                pestaña unmontando el componente, saltar a "Cotizaciones" a
                mirar algo y volver perdía todo, exactamente lo que la Tarea
                9 evitó para el caso de la sesión vencida — solo que ahí sí
                se resolvió. Ahora se renderiza siempre (mientras `dentro`
                sea `true`) y solo se OCULTA con `hidden` cuando no es la
                pestaña activa: `hidden` es `display: none` nativo, saca el
                contenido del árbol de accesibilidad y de la tabulación por
                sí solo, sin necesitar `aria-hidden`/`inert` aparte. Las
                otras dos pestañas siguen desmontándose: no tienen estado
                que valga la pena preservar, y así no siguen pidiendo datos
                de fondo mientras el vendedor está en otra pestaña. */}
            <div hidden={pestana !== 'crear'}>
              <VistaCrear
                skus={skus}
                obtenerCsrf={obtenerCsrf}
                onSesionInvalida={onSesionInvalida}
                plantilla={plantilla}
                onPlantillaConsumida={onPlantillaConsumida}
                rol={rol}
              />
            </div>
            {pestana === 'cotizaciones' && (
              <VistaListado
                obtenerCsrf={obtenerCsrf}
                onSesionInvalida={onSesionInvalida}
                onDuplicar={onDuplicar}
                filtroInicial={filtroListadoInicial}
                onFiltroInicialConsumido={() => setFiltroListadoInicial('')}
              />
            )}
            {pestana === 'metricas' && (
              <VistaMetricas onSesionInvalida={onSesionInvalida} onVerFallidas={onVerFallidas} />
            )}
            {/* Tarea 6: mismo `rol === 'superadmin'` de la pestaña, no sólo
                `pestana === 'equipo'` — sin este segundo chequeo, un
                vendedor que estuvo en esta pestaña como superadmin en una
                sesión previa (mismo tab del navegador, sesión reautenticada
                con una cuenta distinta luego de "Salir") vería el contenido
                un instante, aunque las rutas igual lo rechacen con 403 al
                primer fetch. De nuevo: cosmético, no protección — ver el
                comentario junto a la pestaña. */}
            {pestana === 'equipo' && rol === 'superadmin' && (
              <VistaEquipo obtenerCsrf={obtenerCsrf} onSesionInvalida={onSesionInvalida} />
            )}
            {/* Fase 5: mismo doble chequeo que "Equipo", mismo motivo -- ver
                el comentario junto a la pestaña. */}
            {pestana === 'aprobaciones' && rol === 'superadmin' && (
              <VistaAprobaciones obtenerCsrf={obtenerCsrf} onSesionInvalida={onSesionInvalida} />
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
