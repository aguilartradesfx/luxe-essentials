'use client';

import { useEffect, useMemo, useState } from 'react';

// La pestaña "Campañas" (bandeja de campañas, parte 2). Sólo la ve un
// superadmin de VERDAD -- "de verdad" porque, aunque `Panel` sólo dibuja el
// botón que lleva acá cuando `rol === 'superadmin'` (ver el comentario
// junto a esa pestaña en Panel.tsx), esa condición es cosmética: las siete
// rutas de app/api/campanas/* releen la fila de quien hace la petición en
// la base antes de actuar (`autorizarSuperadmin`, lib/cotizador/equipo.ts)
// y devuelven 403 si no es superadmin ahora mismo -- mismo criterio, exacto,
// que VistaEquipo.tsx y VistaAprobaciones.tsx. Este componente no agrega
// ninguna protección propia: si alguien llega hasta acá sin serlo, el
// primer fetch le devuelve 403 y esta pantalla lo muestra como cualquier
// otro error.
//
// La decisión de POR QUÉ toda la superficie de campañas -- no sólo enviar
// -- queda detrás de superadmin está explicada en
// app/api/campanas/zonas/route.ts: mandar miles de correos en nombre de
// Luxe no se deshace, así que se trató con el mismo criterio conservador
// que ya rige equipo y aprobaciones, no con el criterio (más permisivo) de
// crear una cotización.

// Mismo motivo que la duplicación de tipos en VistaEquipo.tsx/VistaAprobaciones.tsx:
// lib/campanas/* arranca con `import 'server-only'` -- un componente de
// cliente no puede importarlo. Se repiten acá los mismos valores.
const ZONAS_COMERCIALES = [
  'GAM Oeste',
  'GAM Centro',
  'GAM Este / Cartago',
  'Heredia / Norte GAM',
  'Alajuela / Occidente',
  'Zona Norte',
  'Guanacaste Costa',
  'Guanacaste Interior',
  'Península Nicoya',
  'Pacífico Central',
  'Pacífico Sur',
  'Caribe',
  'Revisión manual',
] as const;
type ZonaComercial = (typeof ZONAS_COMERCIALES)[number];

const PLANTILLAS = ['inicial', 'seguimiento_1', 'seguimiento_2', 'seguimiento_3'] as const;
type PlantillaCampana = (typeof PLANTILLAS)[number];

const ETIQUETAS_PLANTILLA: Record<PlantillaCampana, string> = {
  inicial: 'Correo inicial',
  seguimiento_1: 'Primer seguimiento',
  seguimiento_2: 'Segundo seguimiento',
  seguimiento_3: 'Tercer seguimiento (cierre)',
};

const TAMANOS_PAGINA = [20, 50, 100] as const;
type TamanoPagina = (typeof TAMANOS_PAGINA)[number];

type ContactoZona = { contactId: string; nombreCrm: string; correo: string | null };

type ZonaConteo = { zona: ZonaComercial; total: number; conCorreo: number; error?: string };

type PlantillaConParrafos = { plantilla: PlantillaCampana; asunto: string; previewText: string; parrafos: string[] };

type ProgresoCampana = { total: number; enviados: number; fallidos: number; pendientes: number };
type FilaCampana = {
  id: string;
  plantilla: PlantillaCampana;
  asunto: string;
  creadoPor: string;
  creadoAt: string;
  progreso: ProgresoCampana;
};

// La selección es UN modo a la vez, nunca una mezcla -- es justamente lo
// que hace imposible confundir "esta página" con "toda la zona":
//   - 'ninguna': nada elegido.
//   - 'manual': la persona marcó contactos puntuales (uno por uno, o de
//     golpe con "Seleccionar esta página") -- `ids` es la lista exacta.
//   - 'zona': TODOS los contactos con correo de la zona activa, sin
//     importar la página -- no lleva `ids` porque no hace falta: la ruta
//     /crear, del lado del servidor, vuelve a pedirle la zona entera a GHL
//     y toma a todos los que tengan correo (ver el comentario grande en
//     app/api/campanas/crear/route.ts).
type Seleccion = { modo: 'ninguna' } | { modo: 'manual'; ids: Set<string> } | { modo: 'zona' };

type Mensaje = { tipo: 'ok' | 'error' | 'aviso'; texto: string };

function formatearFecha(iso: string): string {
  const f = new Date(iso);
  if (Number.isNaN(f.getTime())) return iso;
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${dos(f.getDate())}/${dos(f.getMonth() + 1)}/${f.getFullYear()} ${dos(f.getHours())}:${dos(f.getMinutes())}`;
}

const PALABRA_CONFIRMACION = 'ENVIAR';

type Props = {
  // Token anti-CSRF vigente, para las acciones que escriben (crear, enviar).
  // Mismo mecanismo que usan VistaEquipo/VistaAprobaciones/VistaListado.
  obtenerCsrf: () => string | null;
  // Mismo mecanismo que ya tiene Panel para un 401 a mitad de trabajo.
  onSesionInvalida: () => void;
};

export function VistaCampanas({ obtenerCsrf, onSesionInvalida }: Props) {
  // --- Historial de campañas (para "retomar" una interrumpida) ---------
  const [campanas, setCampanas] = useState<FilaCampana[] | null>(null);
  const [errorCampanas, setErrorCampanas] = useState('');

  async function cargarCampanas() {
    setErrorCampanas('');
    try {
      const res = await fetch('/api/campanas/listado', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        if (res.status === 401) return onSesionInvalida();
        setErrorCampanas(datos.error ?? `Error ${res.status}`);
        return;
      }
      setCampanas(datos.campanas as FilaCampana[]);
    } catch {
      setErrorCampanas('Fallo de red al consultar el historial de campañas.');
    }
  }

  useEffect(() => {
    void cargarCampanas();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sólo al montar.
  }, []);

  const campanaInterrumpida = useMemo(
    () => (campanas ?? []).find((c) => c.progreso.pendientes > 0) ?? null,
    [campanas],
  );

  // --- Conteo por zona (las trece pestañas) -----------------------------
  const [zonas, setZonas] = useState<ZonaConteo[] | null>(null);
  const [cargandoZonas, setCargandoZonas] = useState(false);
  const [errorZonas, setErrorZonas] = useState('');
  const [zonaActiva, setZonaActiva] = useState<ZonaComercial>(ZONAS_COMERCIALES[0]);

  useEffect(() => {
    let cancelado = false;
    async function cargar() {
      setCargandoZonas(true);
      setErrorZonas('');
      try {
        const res = await fetch('/api/campanas/zonas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const datos = await res.json();
        if (cancelado) return;
        if (!res.ok || !datos.ok) {
          if (res.status === 401) return onSesionInvalida();
          setErrorZonas(datos.error ?? `Error ${res.status}`);
          return;
        }
        setZonas(datos.zonas as ZonaConteo[]);
      } catch {
        if (!cancelado) setErrorZonas('Fallo de red al consultar las zonas.');
      } finally {
        if (!cancelado) setCargandoZonas(false);
      }
    }
    void cargar();
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sólo al montar.
  }, []);

  // --- Contactos de la zona activa (cacheados por zona, para no volver a
  // pedirle lo mismo a GHL cada vez que se cambia de pestaña) -----------
  const [contactosPorZona, setContactosPorZona] = useState<Partial<Record<ZonaComercial, ContactoZona[]>>>({});
  const [cargandoContactos, setCargandoContactos] = useState(false);
  const [errorContactos, setErrorContactos] = useState('');
  const [pagina, setPagina] = useState(1);
  const [tamanoPagina, setTamanoPagina] = useState<TamanoPagina>(20);
  const [seleccion, setSeleccion] = useState<Seleccion>({ modo: 'ninguna' });

  const contactos = contactosPorZona[zonaActiva] ?? null;

  useEffect(() => {
    if (contactosPorZona[zonaActiva]) return; // ya en caché
    let cancelado = false;
    async function cargar() {
      setCargandoContactos(true);
      setErrorContactos('');
      try {
        const res = await fetch('/api/campanas/contactos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ zona: zonaActiva }),
        });
        const datos = await res.json();
        if (cancelado) return;
        if (!res.ok || !datos.ok) {
          if (res.status === 401) return onSesionInvalida();
          setErrorContactos(datos.error ?? `Error ${res.status}`);
          return;
        }
        setContactosPorZona((prev) => ({ ...prev, [zonaActiva]: datos.contactos as ContactoZona[] }));
      } catch {
        if (!cancelado) setErrorContactos('Fallo de red al consultar los contactos.');
      } finally {
        if (!cancelado) setCargandoContactos(false);
      }
    }
    void cargar();
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depende de zonaActiva y del caché.
  }, [zonaActiva]);

  // Cambiar de zona reinicia página y selección -- una selección de una
  // zona no tiene ningún sentido en otra.
  function elegirZona(zona: ZonaComercial) {
    setZonaActiva(zona);
    setPagina(1);
    setSeleccion({ modo: 'ninguna' });
  }

  const conCorreoZona = useMemo(() => (contactos ?? []).filter((c) => c.correo !== null), [contactos]);
  const totalPaginas = Math.max(1, Math.ceil((contactos?.length ?? 0) / tamanoPagina));
  const paginaSegura = Math.min(pagina, totalPaginas);
  const contactosPagina = useMemo(
    () => (contactos ?? []).slice((paginaSegura - 1) * tamanoPagina, paginaSegura * tamanoPagina),
    [contactos, paginaSegura, tamanoPagina],
  );
  const conCorreoPagina = useMemo(() => contactosPagina.filter((c) => c.correo !== null), [contactosPagina]);

  // Cuántos destinatarios implica la selección ACTUAL -- es el número que
  // se repite en los botones y en la confirmación, para que la diferencia
  // entre "esta página" y "toda la zona" sea un número visible, no algo
  // que haya que adivinar.
  const cantidadSeleccionada =
    seleccion.modo === 'zona' ? conCorreoZona.length : seleccion.modo === 'manual' ? seleccion.ids.size : 0;

  function estaSeleccionado(contactId: string): boolean {
    if (seleccion.modo === 'zona') return true;
    if (seleccion.modo === 'manual') return seleccion.ids.has(contactId);
    return false;
  }

  function alternarContacto(contacto: ContactoZona) {
    if (contacto.correo === null) return; // no se puede seleccionar: no hay a dónde escribirle
    setSeleccion((prev) => {
      const ids = new Set(prev.modo === 'manual' ? prev.ids : []); // salir de 'zona' arranca un manual nuevo
      if (ids.has(contacto.contactId)) ids.delete(contacto.contactId);
      else ids.add(contacto.contactId);
      return { modo: 'manual', ids };
    });
  }

  function seleccionarPagina() {
    setSeleccion({ modo: 'manual', ids: new Set(conCorreoPagina.map((c) => c.contactId)) });
  }

  function seleccionarZonaCompleta() {
    setSeleccion({ modo: 'zona' });
  }

  function limpiarSeleccion() {
    setSeleccion({ modo: 'ninguna' });
  }

  // --- Plantillas y edición de párrafos ---------------------------------
  const [plantillas, setPlantillas] = useState<PlantillaConParrafos[] | null>(null);
  const [errorPlantillas, setErrorPlantillas] = useState('');
  const [plantillaElegida, setPlantillaElegida] = useState<PlantillaCampana>('inicial');
  const [parrafosEditados, setParrafosEditados] = useState<Partial<Record<PlantillaCampana, string[]>>>({});

  useEffect(() => {
    let cancelado = false;
    async function cargar() {
      setErrorPlantillas('');
      try {
        const res = await fetch('/api/campanas/plantillas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const datos = await res.json();
        if (cancelado) return;
        if (!res.ok || !datos.ok) {
          if (res.status === 401) return onSesionInvalida();
          setErrorPlantillas(datos.error ?? `Error ${res.status}`);
          return;
        }
        setPlantillas(datos.plantillas as PlantillaConParrafos[]);
      } catch {
        if (!cancelado) setErrorPlantillas('Fallo de red al consultar las plantillas.');
      }
    }
    void cargar();
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sólo al montar.
  }, []);

  const plantillaActual = plantillas?.find((p) => p.plantilla === plantillaElegida) ?? null;
  const parrafosActuales = parrafosEditados[plantillaElegida] ?? plantillaActual?.parrafos ?? [];

  function editarParrafo(indice: number, texto: string) {
    setParrafosEditados((prev) => {
      const base = prev[plantillaElegida] ?? plantillaActual?.parrafos ?? [];
      const copia = [...base];
      copia[indice] = texto;
      return { ...prev, [plantillaElegida]: copia };
    });
  }

  // --- Vista previa ------------------------------------------------------
  const [destinatarioPreviewId, setDestinatarioPreviewId] = useState('');
  const [previsualizacion, setPrevisualizacion] = useState<{ asunto: string; previewText: string; html: string } | null>(
    null,
  );
  const [cargandoPreview, setCargandoPreview] = useState(false);
  const [errorPreview, setErrorPreview] = useState('');

  const seleccionados = useMemo(() => {
    if (seleccion.modo === 'zona') return conCorreoZona;
    if (seleccion.modo === 'manual') return (contactos ?? []).filter((c) => seleccion.ids.has(c.contactId));
    return [];
  }, [seleccion, conCorreoZona, contactos]);

  useEffect(() => {
    // Si quien estaba elegido para la vista previa sale de la selección
    // (cambió de página, deseleccionó), se recae en el primero disponible.
    if (seleccionados.length === 0) {
      setDestinatarioPreviewId('');
      return;
    }
    if (!seleccionados.some((c) => c.contactId === destinatarioPreviewId)) {
      setDestinatarioPreviewId(seleccionados[0].contactId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- se compara con el valor previo a propósito.
  }, [seleccionados]);

  async function previsualizar() {
    const destinatario = seleccionados.find((c) => c.contactId === destinatarioPreviewId);
    if (!destinatario || destinatario.correo === null) return;
    setCargandoPreview(true);
    setErrorPreview('');
    setPrevisualizacion(null);
    try {
      const res = await fetch('/api/campanas/previsualizar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plantilla: plantillaElegida,
          parrafos: parrafosActuales,
          destinatario: { nombreCrm: destinatario.nombreCrm, correo: destinatario.correo },
        }),
      });
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        if (res.status === 401) return onSesionInvalida();
        setErrorPreview(datos.error ?? `Error ${res.status}`);
        return;
      }
      setPrevisualizacion({ asunto: datos.asunto, previewText: datos.previewText, html: datos.html });
    } catch {
      setErrorPreview('Fallo de red al armar la vista previa.');
    } finally {
      setCargandoPreview(false);
    }
  }

  // --- Confirmación + creación + envío por tandas ------------------------
  const [mostrarConfirmacion, setMostrarConfirmacion] = useState(false);
  const [textoConfirmacion, setTextoConfirmacion] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [mensaje, setMensaje] = useState<Mensaje | null>(null);
  // La campaña en curso -- se pinta acá apenas se crea, y el progreso se va
  // actualizando tanda a tanda. `null` en reposo.
  const [campanaEnCurso, setCampanaEnCurso] = useState<{ id: string; plantilla: PlantillaCampana } | null>(null);
  const [progresoEnCurso, setProgresoEnCurso] = useState<ProgresoCampana | null>(null);

  function abrirConfirmacion() {
    setTextoConfirmacion('');
    setMensaje(null);
    setMostrarConfirmacion(true);
  }

  // Manda tandas de a una (POST /api/campanas/enviar) hasta que el
  // servidor dice `terminada: true`. Cada llamada es independiente y
  // retomable -- si la pestaña se cierra a mitad de este `while`, el
  // registro por destinatario queda tal como estaba del lado del servidor
  // (lib/campanas/envio.ts) y volver a esta pantalla más tarde ofrece
  // "Retomar" sobre la misma campaña (ver el bloque de historial, arriba).
  async function enviarPorTandas(campanaId: string) {
    for (;;) {
      let res: Response;
      try {
        res = await fetch('/api/campanas/enviar', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(obtenerCsrf() ? { 'x-csrf-token': obtenerCsrf()! } : {}),
          },
          body: JSON.stringify({ campanaId }),
        });
      } catch {
        setMensaje({
          tipo: 'error',
          texto: 'Fallo de red a mitad del envío. La campaña quedó donde iba -- volvé a "Retomar" cuando haya conexión.',
        });
        return;
      }
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        if (res.status === 401) return onSesionInvalida();
        setMensaje({
          tipo: 'error',
          texto: `${datos.error ?? `Error ${res.status}`} La campaña quedó donde iba -- se puede retomar.`,
        });
        return;
      }
      setProgresoEnCurso((prev) => {
        const base = prev ?? { total: 0, enviados: 0, fallidos: 0, pendientes: 0 };
        return {
          total: base.total,
          enviados: base.enviados + datos.enviados,
          fallidos: base.fallidos + datos.fallidos,
          pendientes: Math.max(0, base.pendientes - datos.procesados),
        };
      });
      if (datos.terminada) {
        setMensaje({ tipo: 'ok', texto: 'La campaña terminó de enviarse.' });
        await cargarCampanas();
        return;
      }
    }
  }

  async function confirmarYEnviar() {
    if (textoConfirmacion.trim().toUpperCase() !== PALABRA_CONFIRMACION) return;
    setEnviando(true);
    setMensaje(null);
    try {
      const csrf = obtenerCsrf();
      const res = await fetch('/api/campanas/crear', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({
          zona: zonaActiva,
          seleccion: seleccion.modo === 'zona' ? 'zona' : 'pagina',
          contactIds: seleccion.modo === 'manual' ? [...seleccion.ids] : undefined,
          plantilla: plantillaElegida,
          parrafos: parrafosActuales,
        }),
      });
      const datos = await res.json();
      if (!res.ok || !datos.ok) {
        if (res.status === 401) {
          onSesionInvalida();
          return;
        }
        setMensaje({ tipo: 'error', texto: datos.error ?? `Error ${res.status}` });
        return;
      }
      setMostrarConfirmacion(false);
      setCampanaEnCurso({ id: datos.campanaId, plantilla: plantillaElegida });
      setProgresoEnCurso({ total: datos.destinatarios, enviados: 0, fallidos: 0, pendientes: datos.destinatarios });
      if (datos.excluidosPorBaja > 0) {
        setMensaje({
          tipo: 'aviso',
          texto: `${datos.excluidosPorBaja} de la selección ya estaban dados de baja de estos correos -- no se les mandó nada.`,
        });
      }
      await enviarPorTandas(datos.campanaId);
    } catch {
      setMensaje({ tipo: 'error', texto: 'Fallo de red al crear la campaña.' });
    } finally {
      setEnviando(false);
    }
  }

  async function retomar(campanaId: string, plantilla: PlantillaCampana, progresoActual: ProgresoCampana) {
    setCampanaEnCurso({ id: campanaId, plantilla });
    setProgresoEnCurso(progresoActual);
    setMensaje(null);
    setEnviando(true);
    try {
      await enviarPorTandas(campanaId);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="space-y-6">
      {errorCampanas && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
          {errorCampanas}
        </p>
      )}

      {/* Campaña interrumpida: lo primero que se ve, porque es lo más
          urgente -- una campaña a medias es dinero (y contactos) esperando.
          El registro por destinatario ya existe del lado del servidor
          desde que se creó; esto es lo único que lo hace visible. */}
      {campanaInterrumpida && !campanaEnCurso && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            Hay una campaña sin terminar: {ETIQUETAS_PLANTILLA[campanaInterrumpida.plantilla]}, creada por{' '}
            {campanaInterrumpida.creadoPor} el {formatearFecha(campanaInterrumpida.creadoAt)}.
          </p>
          <p className="mt-1 text-xs text-amber-800">
            {campanaInterrumpida.progreso.enviados} de {campanaInterrumpida.progreso.total} enviados
            {campanaInterrumpida.progreso.fallidos > 0 ? `, ${campanaInterrumpida.progreso.fallidos} con error` : ''}
            . Quedan {campanaInterrumpida.progreso.pendientes} por mandar.
          </p>
          <button
            type="button"
            disabled={enviando}
            onClick={() =>
              void retomar(campanaInterrumpida.id, campanaInterrumpida.plantilla, campanaInterrumpida.progreso)
            }
            className="mt-3 rounded-lg bg-navy px-4 py-2 text-sm font-medium text-beige hover:bg-navy/90 disabled:opacity-40"
          >
            Retomar el envío
          </button>
        </div>
      )}

      {/* Progreso de la campaña en curso (recién creada, o retomada). */}
      {campanaEnCurso && progresoEnCurso && (
        <div className="rounded-xl border border-[var(--carta-border)] bg-white p-4" aria-live="polite">
          <p className="text-sm font-medium text-navy">
            Enviando {ETIQUETAS_PLANTILLA[campanaEnCurso.plantilla]} -- {progresoEnCurso.enviados + progresoEnCurso.fallidos}{' '}
            de {progresoEnCurso.total} procesados
          </p>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--carta-fill)]">
            <div
              className="h-full bg-teal transition-all"
              style={{
                width: `${progresoEnCurso.total === 0 ? 0 : Math.round(((progresoEnCurso.enviados + progresoEnCurso.fallidos) / progresoEnCurso.total) * 100)}%`,
              }}
            />
          </div>
          <p className="mt-2 text-xs text-teal">
            {progresoEnCurso.enviados} enviados
            {progresoEnCurso.fallidos > 0 ? `, ${progresoEnCurso.fallidos} con error` : ''}, {progresoEnCurso.pendientes}{' '}
            pendientes.
            {progresoEnCurso.pendientes === 0 ? ' Terminada.' : enviando ? ' Enviando…' : ' Interrumpida.'}
          </p>
          {!enviando && progresoEnCurso.pendientes > 0 && (
            <button
              type="button"
              onClick={() => void retomar(campanaEnCurso.id, campanaEnCurso.plantilla, progresoEnCurso)}
              className="mt-2 rounded-lg border border-[var(--carta-border)] px-3 py-1.5 text-xs font-medium text-navy hover:bg-[var(--carta-fill)]"
            >
              Retomar
            </button>
          )}
        </div>
      )}

      {mensaje && (
        <p
          role="alert"
          className={`rounded-lg px-3 py-2 text-sm ${
            mensaje.tipo === 'error'
              ? 'bg-red-50 text-red-800'
              : mensaje.tipo === 'aviso'
                ? 'bg-amber-50 text-amber-800'
                : 'bg-emerald-50 text-emerald-800'
          }`}
        >
          {mensaje.texto}
        </p>
      )}

      {/* Zona comercial: antes trece pestañas -- trece no entran en ningún
          ancho razonable, y menos todavía junto a la tabla de contactos, que
          ya necesita su propio espacio. Pasa a un desplegable de una zona a
          la vez.

          El conteo de contactos NO se esconde dentro del desplegable
          cerrado (ahí sólo se vería abriéndolo, y ni siquiera entonces se
          vería cuál está elegida sin buscarla en la lista): se repite,
          siempre visible, al lado -- ver el `<span aria-live>` de abajo.
          Cada `<option>` también lleva su propio conteo, para poder
          comparar zonas antes de elegir una.

          Ojo con la selección al cambiar de zona: los contactos elegidos en
          una zona no significan nada en otra -- son personas distintas, y
          "cambié de zona pero la selección de la anterior seguía marcada"
          es la forma más fácil de mandarle una campaña a la gente
          equivocada. La más segura de las dos salidas es descartarla de
          entrada, así que `elegirZona` (más abajo en este archivo) sigue
          vaciando `seleccion` en cada cambio -- ya lo hacía con las
          pestañas, y el desplegable llama a la misma función, así que el
          comportamiento no cambió, sólo el control que lo dispara. Prueba
          que lo ancla: "cambiar de zona descarta la selección anterior…"
          en tests/vista-campanas-ui.test.tsx -- verificada por mutación
          (a mano): comentar el `setSeleccion({ modo: 'ninguna' })` de
          `elegirZona` pone esa prueba en rojo. */}
      <div>
        <h2 className="font-display text-sm text-navy">Zona comercial</h2>
        {errorZonas && (
          <p role="alert" className="mt-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
            {errorZonas}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label htmlFor="campanas-zona" className="flex items-center gap-2 text-xs text-teal">
            Elegir zona
            <select
              id="campanas-zona"
              value={zonaActiva}
              onChange={(e) => elegirZona(e.target.value as ZonaComercial)}
              className="rounded-lg border border-[var(--carta-border)] bg-white px-2 py-1.5 text-sm text-navy"
            >
              {ZONAS_COMERCIALES.map((zona) => {
                const conteo = zonas?.find((z) => z.zona === zona);
                return (
                  <option key={zona} value={zona}>
                    {zona}
                    {cargandoZonas && !conteo ? ' (…)' : conteo ? ` (${conteo.conCorreo}/${conteo.total})` : ''}
                  </option>
                );
              })}
            </select>
          </label>
          {/* El conteo de la zona ELEGIDA, siempre a la vista -- no sólo
              dentro de la opción del desplegable, que sólo se ve al
              abrirlo. */}
          <span className="text-xs text-teal" aria-live="polite">
            {(() => {
              const conteoActivo = zonas?.find((z) => z.zona === zonaActiva);
              if (cargandoZonas && !conteoActivo) return 'Cargando conteo…';
              if (!conteoActivo) return null;
              return `${conteoActivo.conCorreo} de ${conteoActivo.total} contactos de esta zona tienen correo.`;
            })()}
          </span>
        </div>
      </div>

      {/* Contactos de la zona activa: paginado, selección de página vs. zona */}
      <div>
        {cargandoContactos && <p className="text-xs text-teal/70">Cargando contactos…</p>}
        {errorContactos && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
            {errorContactos}
          </p>
        )}

        {contactos && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <label htmlFor="campanas-tamano-pagina" className="text-xs text-teal">
                  Por página
                </label>
                <select
                  id="campanas-tamano-pagina"
                  value={tamanoPagina}
                  onChange={(e) => {
                    setTamanoPagina(Number(e.target.value) as TamanoPagina);
                    setPagina(1);
                  }}
                  className="ml-2 rounded-lg border border-[var(--carta-border)] bg-white px-2 py-1 text-xs text-navy"
                >
                  {TAMANOS_PAGINA.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2 text-xs text-teal">
                <button
                  type="button"
                  disabled={paginaSegura <= 1}
                  onClick={() => setPagina((p) => Math.max(1, p - 1))}
                  className="rounded-lg border border-[var(--carta-border)] px-2 py-1 disabled:opacity-40"
                >
                  Anterior
                </button>
                <span>
                  Página {paginaSegura} de {totalPaginas}
                </span>
                <button
                  type="button"
                  disabled={paginaSegura >= totalPaginas}
                  onClick={() => setPagina((p) => Math.min(totalPaginas, p + 1))}
                  className="rounded-lg border border-[var(--carta-border)] px-2 py-1 disabled:opacity-40"
                >
                  Siguiente
                </button>
              </div>
            </div>

            {/* Los dos botones de selección -- deliberadamente distintos en
                tamaño de número, color y texto, para que confundir uno con
                otro sea difícil de hacer sin darse cuenta. */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={seleccionarPagina}
                disabled={conCorreoPagina.length === 0}
                className="rounded-lg border border-[var(--carta-border)] px-3 py-1.5 text-xs font-medium text-navy hover:bg-[var(--carta-fill)] disabled:opacity-40"
              >
                Seleccionar esta página ({conCorreoPagina.length})
              </button>
              <button
                type="button"
                onClick={seleccionarZonaCompleta}
                disabled={conCorreoZona.length === 0}
                className="rounded-lg border-2 border-amber-600 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-40"
              >
                Seleccionar TODA la zona ({conCorreoZona.length})
              </button>
              {seleccion.modo !== 'ninguna' && (
                <button
                  type="button"
                  onClick={limpiarSeleccion}
                  className="rounded-lg px-3 py-1.5 text-xs text-teal underline underline-offset-2 hover:text-navy"
                >
                  Quitar selección
                </button>
              )}
              <span className="text-xs text-teal" aria-live="polite">
                {seleccion.modo === 'zona' && `Toda la zona seleccionada: ${cantidadSeleccionada} destinatarios.`}
                {seleccion.modo === 'manual' && `${cantidadSeleccionada} destinatarios seleccionados en esta página.`}
                {seleccion.modo === 'ninguna' && 'Nada seleccionado todavía.'}
              </span>
            </div>

            <div className="mt-3 overflow-x-auto rounded-xl border border-[var(--carta-border)]">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="bg-[var(--carta-fill)] text-xs uppercase tracking-wide text-teal">
                  <tr>
                    <th className="px-3 py-2">
                      <span className="sr-only">Seleccionar</span>
                    </th>
                    <th className="px-3 py-2">Nombre / empresa</th>
                    <th className="px-3 py-2">Correo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--carta-border)]">
                  {contactosPagina.map((c) => {
                    const sinCorreo = c.correo === null;
                    return (
                      <tr key={c.contactId} className={sinCorreo ? 'opacity-60' : undefined}>
                        <td className="px-3 py-2 align-top">
                          <label className="sr-only" htmlFor={`sel-${c.contactId}`}>
                            Seleccionar a {c.nombreCrm}
                          </label>
                          <input
                            id={`sel-${c.contactId}`}
                            type="checkbox"
                            checked={estaSeleccionado(c.contactId)}
                            disabled={sinCorreo || seleccion.modo === 'zona'}
                            onChange={() => alternarContacto(c)}
                            className="h-4 w-4 rounded border-[var(--carta-border)]"
                          />
                        </td>
                        <td className="px-3 py-2 align-top text-navy">{c.nombreCrm || '(sin nombre)'}</td>
                        <td className="px-3 py-2 align-top text-teal">
                          {sinCorreo ? (
                            <span title="Este contacto no tiene correo en el CRM: no se le puede escribir.">
                              Sin correo -- no se puede seleccionar
                            </span>
                          ) : (
                            c.correo
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Plantilla y edición de texto */}
      <div className="rounded-xl border border-[var(--carta-border)] p-4">
        <h2 className="font-display text-sm text-navy">Plantilla</h2>
        {errorPlantillas && (
          <p role="alert" className="mt-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
            {errorPlantillas}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {PLANTILLAS.map((p) => (
            <label
              key={p}
              htmlFor={`plantilla-${p}`}
              className={`cursor-pointer rounded-full border px-3 py-1.5 text-xs font-medium ${
                plantillaElegida === p
                  ? 'border-navy bg-navy text-beige'
                  : 'border-[var(--carta-border)] text-navy hover:bg-[var(--carta-fill)]'
              }`}
            >
              <input
                id={`plantilla-${p}`}
                type="radio"
                name="plantilla"
                value={p}
                checked={plantillaElegida === p}
                onChange={() => setPlantillaElegida(p)}
                className="sr-only"
              />
              {ETIQUETAS_PLANTILLA[p]}
            </label>
          ))}
        </div>

        {plantillaActual && (
          <div className="mt-4 space-y-3">
            <p className="text-xs text-teal">
              Asunto: <span className="text-navy">{plantillaActual.asunto}</span>
            </p>
            <p className="text-xs text-teal">
              Se edita sólo el texto de cada párrafo. El diseño del correo (tablas, botón, firma) no se toca --
              está armado para verse bien incluso en Outlook, y un cambio ahí puede romperlo.
            </p>
            {parrafosActuales.map((texto, i) => (
              <div key={i}>
                <label htmlFor={`parrafo-${i}`} className="block text-xs font-medium uppercase tracking-wide text-teal">
                  Párrafo {i + 1}
                </label>
                <textarea
                  id={`parrafo-${i}`}
                  value={texto}
                  onChange={(e) => editarParrafo(i, e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-[var(--carta-border)] bg-white px-3 py-2 text-sm text-navy"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Vista previa, con un destinatario real de la selección */}
      <div className="rounded-xl border border-[var(--carta-border)] p-4">
        <h2 className="font-display text-sm text-navy">Vista previa</h2>
        {seleccionados.length === 0 ? (
          <p className="mt-1 text-xs text-teal">Elegí al menos un destinatario para poder previsualizar.</p>
        ) : (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="campanas-destinatario-preview" className="block text-xs text-teal">
                Destinatario
              </label>
              <select
                id="campanas-destinatario-preview"
                value={destinatarioPreviewId}
                onChange={(e) => setDestinatarioPreviewId(e.target.value)}
                className="mt-1 rounded-lg border border-[var(--carta-border)] bg-white px-2 py-1.5 text-xs text-navy"
              >
                {seleccionados.map((c) => (
                  <option key={c.contactId} value={c.contactId}>
                    {c.nombreCrm || c.correo} ({c.correo})
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              disabled={cargandoPreview}
              onClick={() => void previsualizar()}
              className="rounded-lg border border-[var(--carta-border)] px-3 py-1.5 text-xs font-medium text-navy hover:bg-[var(--carta-fill)] disabled:opacity-40"
            >
              {cargandoPreview ? 'Armando…' : 'Previsualizar'}
            </button>
          </div>
        )}
        {errorPreview && (
          <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
            {errorPreview}
          </p>
        )}
        {previsualizacion && (
          <div className="mt-3">
            <p className="text-xs text-teal">
              Asunto: <span className="text-navy">{previsualizacion.asunto}</span>
            </p>
            <iframe
              title="Vista previa del correo"
              srcDoc={previsualizacion.html}
              sandbox=""
              className="mt-2 h-96 w-full rounded-lg border border-[var(--carta-border)] bg-white"
            />
          </div>
        )}
      </div>

      {/* Enviar -- exige la confirmación de abajo, nunca dispara directo. */}
      <div>
        <button
          type="button"
          disabled={cantidadSeleccionada === 0 || enviando || Boolean(campanaEnCurso)}
          onClick={abrirConfirmacion}
          className="rounded-lg bg-navy px-4 py-2.5 text-sm font-medium text-beige hover:bg-navy/90 disabled:opacity-40"
        >
          Enviar a {cantidadSeleccionada} destinatario{cantidadSeleccionada === 1 ? '' : 's'}
        </button>
      </div>

      {/* La confirmación: a cuántos, de qué zona, con qué plantilla -- y
          exige escribir la palabra de confirmación, no un botón que se
          pueda apretar de paso. Pedido expreso del dueño (ver el brief de
          esta tarea): enviar es irreversible y masivo, así que este es el
          último punto donde un error todavía es gratis. */}
      {mostrarConfirmacion && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="campanas-confirmar-titulo"
          className="fixed inset-0 z-50 flex items-center justify-center bg-navy/50 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h2 id="campanas-confirmar-titulo" className="font-display text-base text-navy">
              Confirmar envío
            </h2>
            <p className="mt-2 text-sm text-navy">
              Vas a enviarle <strong>{ETIQUETAS_PLANTILLA[plantillaElegida]}</strong> a{' '}
              <strong>{cantidadSeleccionada}</strong> destinatario{cantidadSeleccionada === 1 ? '' : 's'} de{' '}
              <strong>{zonaActiva}</strong>
              {seleccion.modo === 'zona' ? ' (la zona completa)' : ' (la selección puntual de esta página)'}.
            </p>
            <p className="mt-2 text-xs text-teal">Esto no se puede deshacer una vez enviado.</p>
            <label htmlFor="campanas-confirmar-texto" className="mt-4 block text-xs font-medium uppercase tracking-wide text-teal">
              Escribí {PALABRA_CONFIRMACION} para confirmar
            </label>
            <input
              id="campanas-confirmar-texto"
              value={textoConfirmacion}
              onChange={(e) => setTextoConfirmacion(e.target.value)}
              autoComplete="off"
              className="mt-1 w-full rounded-lg border border-[var(--carta-border)] bg-white px-3 py-2 text-sm text-navy"
            />
            {mensaje && mensaje.tipo === 'error' && (
              <p role="alert" className="mt-2 text-xs text-red-700">
                {mensaje.texto}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setMostrarConfirmacion(false)}
                className="rounded-lg border border-[var(--carta-border)] px-3 py-1.5 text-sm text-navy"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={textoConfirmacion.trim().toUpperCase() !== PALABRA_CONFIRMACION || enviando}
                onClick={() => void confirmarYEnviar()}
                className="rounded-lg bg-navy px-4 py-1.5 text-sm font-medium text-beige disabled:opacity-40"
              >
                {enviando ? 'Enviando…' : 'Confirmar y enviar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Historial de campañas ya creadas -- visible siempre, no sólo
          cuando hay una interrumpida, para que "¿ya se mandó esto?" tenga
          una respuesta sin salir de la pantalla. */}
      {campanas && campanas.length > 0 && (
        <div>
          <h2 className="font-display text-sm text-navy">Campañas anteriores</h2>
          <div className="mt-2 overflow-x-auto rounded-xl border border-[var(--carta-border)]">
            <table className="w-full min-w-[600px] text-left text-sm">
              <thead className="bg-[var(--carta-fill)] text-xs uppercase tracking-wide text-teal">
                <tr>
                  <th className="px-3 py-2">Plantilla</th>
                  <th className="px-3 py-2">Creada por</th>
                  <th className="px-3 py-2">Fecha</th>
                  <th className="px-3 py-2">Progreso</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--carta-border)]">
                {campanas.map((c) => (
                  <tr key={c.id}>
                    <td className="px-3 py-2 align-top text-navy">{ETIQUETAS_PLANTILLA[c.plantilla]}</td>
                    <td className="px-3 py-2 align-top text-teal">{c.creadoPor}</td>
                    <td className="px-3 py-2 align-top text-teal">{formatearFecha(c.creadoAt)}</td>
                    <td className="px-3 py-2 align-top text-teal">
                      {c.progreso.enviados}/{c.progreso.total} enviados
                      {c.progreso.fallidos > 0 ? `, ${c.progreso.fallidos} con error` : ''}
                      {c.progreso.pendientes > 0 ? ` -- ${c.progreso.pendientes} pendientes` : ' -- terminada'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
