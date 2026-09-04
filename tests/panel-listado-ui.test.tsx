import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VistaListado } from '@/app/cotizador/VistaListado';

// Tarea 10: la pestaña "Cotizaciones" del panel. Mismo patrón que
// tests/cotizador-ui.test.tsx — `fetch` simulado, sin red — pero acotado a
// este componente solo (no pasa por `Panel`): `onDuplicar` y
// `onSesionInvalida` son props, y esta prueba afirma que se llaman con lo
// correcto, en vez de renderizar `VistaCrear` entera para comprobarlo.
//
// Contrato de las respuestas (ver task-8-report.md, sección final): un
// `res.ok` en `/reenviar` NO significa "sin nada que avisar" — puede venir
// `200 { ok: true, actualizado: false, avisoActualizacion }` cuando el
// correo salió pero el registro no se pudo actualizar. Varias pruebas de
// abajo ejercitan justo esa rama.

const CSRF_TOKEN = 'csrf-de-prueba';
const LOCATION_ID = 'ubicacion-ghl-1';

const FILA_ABIERTA = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  numero: 'COT-2026-0010',
  created_at: '2026-08-20T10:00:00.000Z',
  updated_at: '2026-08-20T10:00:00.000Z',
  estado: 'enviada',
  origen: 'humano',
  contact_id: 'contacto-ghl-1',
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Ana', email: 'ana@hotel.com' },
  totales: { subtotal: 500000, ahorro: 0, iva: 65000, total: 565000 },
  enviado_at: '2026-08-20T10:05:00.000Z',
  cerrada_at: null,
  pdf_ruta: '2026/COT-2026-0010.pdf',
  motivo_cierre: null,
  ghl_estimate_id: 'est-10',
  ghl_error: null,
  correo_error: null,
  vendedor: 'Guillermo Rojas',
};

// Creada hace 25 días respecto de "ahora": con 30 días de vigencia, vence
// en 5 — dentro de la ventana de aviso de 7 días — y sigue "sin respuesta"
// (`enviada`), así que tiene que saltar a la vista. Calculado en vivo (no
// una fecha fija) para no depender de cuándo se corra la prueba.
const HACE_25_DIAS = new Date();
HACE_25_DIAS.setDate(HACE_25_DIAS.getDate() - 25);

const FILA_POR_VENCER = {
  ...FILA_ABIERTA,
  id: 'a1b2c3d4-0000-4000-8000-000000000002',
  numero: 'COT-2026-0011',
  created_at: HACE_25_DIAS.toISOString(),
  cliente: { nombre: 'Beto Ruiz', empresa: 'Hotel Beto', email: 'beto@hotel.com' },
  contact_id: null,
  pdf_ruta: '2026/COT-2026-0011.pdf',
};

const FILA_GANADA = {
  ...FILA_ABIERTA,
  id: 'a1b2c3d4-0000-4000-8000-000000000003',
  numero: 'COT-2026-0012',
  estado: 'ganada',
  cerrada_at: '2026-08-21T10:00:00.000Z',
  cliente: { nombre: 'Carla Gómez', empresa: 'Hotel Carla', email: 'carla@hotel.com' },
  contact_id: null,
};

// "Modificar" (migración 0016): la fila vieja que ya fue reemplazada -- sin
// Reenviar ni Modificar disponibles, con el rastro hacia la que la
// reemplazó.
const FILA_REEMPLAZADA = {
  ...FILA_ABIERTA,
  id: 'a1b2c3d4-0000-4000-8000-000000000004',
  numero: 'COT-2026-0013',
  estado: 'reemplazada',
  cliente: { nombre: 'Diana Solís', empresa: 'Hotel Diana', email: 'diana@hotel.com' },
  reemplazada_por_numero: 'COT-2026-0014',
};

// La fila nueva que reemplazó a `FILA_REEMPLAZADA`, con el rastro en el otro
// sentido.
const FILA_REEMPLAZO = {
  ...FILA_ABIERTA,
  id: 'a1b2c3d4-0000-4000-8000-000000000005',
  numero: 'COT-2026-0014',
  cliente: { nombre: 'Diana Solís', empresa: 'Hotel Diana', email: 'diana@hotel.com' },
  reemplaza_a_numero: 'COT-2026-0013',
};

type OpcionesFetch = {
  filas?: unknown[];
  cerrarStatus?: number;
  cerrarError?: string;
  reenviarRespuesta?: unknown;
  reenviarStatus?: number;
  duplicarLineas?: { skuId: string; cantidad: number }[];
  duplicarStatus?: number;
  listado401?: boolean;
  pdfUrl?: string;
  pdfStatus?: number;
  pdfError?: string;
  // Dominio con el que el servidor arma "Ver en Bralto" (ver
  // app/api/cotizacion/listado/route.ts, `LUXE_GHL_DOMINIO`). Sin esto, el
  // mock ni siquiera manda el campo -- así las pruebas que no lo necesitan
  // ejercitan el mismo camino "la respuesta no trae `crmDominio`" que un
  // backend viejo o una `LUXE_GHL_DOMINIO` vacía producirían de verdad.
  crmDominio?: string;
};

function mockFetch(opciones: OpcionesFetch = {}) {
  const llamadas: { url: string; init?: RequestInit }[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    llamadas.push({ url, init });
    const cuerpo = init?.body ? JSON.parse(init.body as string) : {};

    if (url.endsWith('/api/cotizacion/listado')) {
      if (opciones.listado401) {
        return new Response(JSON.stringify({ ok: false, error: 'Clave incorrecta.' }), { status: 401 });
      }
      const todas = opciones.filas ?? [FILA_ABIERTA, FILA_POR_VENCER, FILA_GANADA];
      const filtradas = cuerpo.estado ? todas.filter((f) => (f as { estado: string }).estado === cuerpo.estado) : todas;
      return new Response(
        JSON.stringify({
          ok: true,
          cotizaciones: filtradas,
          locationId: LOCATION_ID,
          ...(opciones.crmDominio ? { crmDominio: opciones.crmDominio } : {}),
        }),
        { status: 200 },
      );
    }

    if (url.endsWith('/api/cotizacion/cerrar')) {
      const status = opciones.cerrarStatus ?? 200;
      const cuerpoRespuesta =
        status === 200 ? { ok: true } : { ok: false, error: opciones.cerrarError ?? 'No se pudo actualizar.' };
      return new Response(JSON.stringify(cuerpoRespuesta), { status });
    }

    if (url.endsWith('/api/cotizacion/reenviar')) {
      const status = opciones.reenviarStatus ?? 200;
      const cuerpoRespuesta =
        opciones.reenviarRespuesta ??
        (status === 200
          ? { ok: true, resendId: 're_1', vencida: false, actualizado: true }
          : { ok: false, error: 'Token anti-CSRF inválido.' });
      return new Response(JSON.stringify(cuerpoRespuesta), { status });
    }

    if (url.endsWith('/api/cotizacion/pdf')) {
      const status = opciones.pdfStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ ok: false, error: opciones.pdfError ?? 'No se pudo firmar el enlace del PDF.' }), { status });
      }
      return new Response(JSON.stringify({ ok: true, url: opciones.pdfUrl ?? 'https://firmada/pdf' }), { status: 200 });
    }

    if (url.endsWith('/api/cotizacion/duplicar')) {
      const status = opciones.duplicarStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ ok: false, error: 'Token anti-CSRF inválido.' }), { status });
      }
      return new Response(
        JSON.stringify({ ok: true, lineas: opciones.duplicarLineas ?? [{ skuId: 'set-600-king', cantidad: 12 }] }),
        { status: 200 },
      );
    }

    throw new Error(`Fetch no simulado en la prueba: ${url}`);
  });
  return { spy, llamadas };
}

function renderVista(props: Partial<Parameters<typeof VistaListado>[0]> = {}) {
  const onSesionInvalida = vi.fn();
  const onDuplicar = vi.fn();
  render(
    <VistaListado
      obtenerCsrf={() => CSRF_TOKEN}
      onSesionInvalida={onSesionInvalida}
      onDuplicar={onDuplicar}
      {...props}
    />,
  );
  return { onSesionInvalida, onDuplicar };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Marcar como ganada / Marcar como perdida / Ver PDF / Reenviar / Duplicar /
// Ver en Bralto viven detrás del botón de tres puntos (menú de acciones) de
// cada fila -- ver `MenuAcciones` en
// VistaListado.tsx. `usuario` ya viene de `userEvent.setup()` en cada
// prueba; este helper solo abre el menú de la fila dada, con el mismo
// cliente. El menú se porta a `document.body` (para no quedar recortado
// por el `overflow-x-auto` de la tabla -- ver el comentario en
// `MenuAcciones`), así que sus ítems ya NO están dentro del `<tr>`: quien
// llama a este helper debe buscarlos con `screen`, no con `within(fila)`.
async function abrirMenu(usuario: ReturnType<typeof userEvent.setup>, fila: HTMLElement) {
  await usuario.click(within(fila).getByRole('button', { name: /más acciones/i }));
}

describe('VistaListado', () => {
  it('lista las cotizaciones con cliente, monto y estado', async () => {
    mockFetch();
    renderVista();

    await waitFor(() => {
      expect(screen.getByText(/ana pérez/i)).toBeInTheDocument();
    });
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    expect(within(fila).getByText(/₡565\.000/)).toBeInTheDocument();
    expect(within(fila).getByText(/enviada/i)).toBeInTheDocument();
  });

  // Tarea 6: cierra el objetivo de la fase -- cada cotización dice quién la
  // armó.
  it('muestra quién armó cada cotización', async () => {
    mockFetch();
    renderVista();

    const fila = await screen.findByText(/ana pérez/i);
    expect(within(fila.closest('tr') as HTMLElement).getByText('Guillermo Rojas')).toBeInTheDocument();
  });

  it('una cotización de antes de esta fase (vendedor null) muestra un guion, sin inventar un nombre', async () => {
    mockFetch({ filas: [{ ...FILA_ABIERTA, vendedor: null }] });
    renderVista();

    await waitFor(() => {
      expect(screen.getByText(/ana pérez/i)).toBeInTheDocument();
    });
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    expect(within(fila).getByText('—')).toBeInTheDocument();
  });

  // Revisión final, T6: la celda usaba `??`, que sólo cubre `null` y
  // `undefined`. Una cadena vacía —el día que alguien rellene las filas viejas
  // con `''` en vez de `null`— se pintaba en blanco en vez de guion, y una
  // celda vacía en esa columna se lee como "no hay dato" cuando en realidad es
  // "el dato es basura". `||` cubre las tres.
  it('una fila con el vendedor en cadena vacía también muestra el guion', async () => {
    mockFetch({ filas: [{ ...FILA_ABIERTA, vendedor: '' }] });
    renderVista();

    await waitFor(() => {
      expect(screen.getByText(/ana pérez/i)).toBeInTheDocument();
    });
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    expect(within(fila).getByText('—')).toBeInTheDocument();
  });

  it('muestra cuáles vencen pronto, de forma visible', async () => {
    mockFetch();
    renderVista();

    await waitFor(() => {
      expect(screen.getByText(/beto ruiz/i)).toBeInTheDocument();
    });
    const fila = screen.getByText(/beto ruiz/i).closest('tr');
    expect(fila).not.toBeNull();
    expect(within(fila as HTMLElement).getByText(/vence en 5 día/i)).toBeInTheDocument();

    // La fila que no vence pronto (o ya está cerrada) no lleva el mismo aviso.
    const filaGanada = screen.getByText(/carla gómez/i).closest('tr');
    expect(within(filaGanada as HTMLElement).queryByText(/vence en/i)).not.toBeInTheDocument();
  });

  // Revisión final (hallazgo menor): `Math.ceil` de una diferencia negativa
  // pero de menos de un día (p. ej. vencida hace 1 hora) da `-0`, no `0` --
  // una rareza de JavaScript. `-0 < 0` es `false`, así que la comparación
  // que decide "vencida" (rojo, "Vencida hace N día(s)") la pasaba por
  // alto, y una cotización que venció ayer se pintaba como si venciera
  // HOY (ámbar, "Vence hoy") -- justo la mentira que un vendedor no puede
  // permitirse creer sobre un precio ya caducado.
  it('una cotización vencida hace menos de un día se muestra vencida, no "Vence hoy"', async () => {
    const HACE_30_DIAS_Y_UNA_HORA = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000));
    mockFetch({
      filas: [
        {
          ...FILA_ABIERTA,
          cliente: { nombre: 'Diego Solís', empresa: 'Hotel Diego', email: 'diego@hotel.com' },
          created_at: HACE_30_DIAS_Y_UNA_HORA.toISOString(),
        },
      ],
    });
    renderVista();

    await waitFor(() => expect(screen.getByText(/diego solís/i)).toBeInTheDocument());
    const fila = screen.getByText(/diego solís/i).closest('tr') as HTMLElement;

    expect(within(fila).queryByText(/vence hoy/i)).not.toBeInTheDocument();
    expect(within(fila).getByText(/vencida hace/i)).toBeInTheDocument();
  });

  it('el filtro por estado cambia lo que se pide al servidor', async () => {
    const { llamadas } = mockFetch();
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => {
      expect(screen.getByText(/ana pérez/i)).toBeInTheDocument();
    });

    await usuario.selectOptions(screen.getByLabelText(/filtrar por estado/i), 'ganada');

    await waitFor(() => {
      const ultima = llamadas.filter((l) => l.url.endsWith('/api/cotizacion/listado')).at(-1);
      expect(ultima).toBeDefined();
      const cuerpo = JSON.parse((ultima!.init!.body as string) ?? '{}');
      expect(cuerpo.estado).toBe('ganada');
    });
  });

  // Hallazgo del dueño (ronda de correcciones): "Ganada"/"Perdida" ya no
  // son botones sueltos en la fila -- confundían al cliente del dueño. Se
  // mudaron al menú de tres puntos, con las etiquetas "Marcar como
  // ganada"/"Marcar como perdida" -- la prueba se adapta para abrir el
  // menú primero y elegir el ítem ahí, conservando exactamente lo mismo
  // que afirmaba antes (qué se manda a `/cerrar`, con qué cabecera).
  it('"Marcar como ganada" llama a /cerrar con el estado correcto', async () => {
    const { llamadas } = mockFetch();
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => {
      expect(screen.getByText(/ana pérez/i)).toBeInTheDocument();
    });
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    await usuario.click(screen.getByRole('menuitem', { name: /marcar como ganada/i }));

    await waitFor(() => {
      const llamada = llamadas.find((l) => l.url.endsWith('/api/cotizacion/cerrar'));
      expect(llamada).toBeDefined();
      const cuerpo = JSON.parse(llamada!.init!.body as string);
      expect(cuerpo).toMatchObject({ id: FILA_ABIERTA.id, estado: 'ganada' });
    });
  });

  // Regla de seguridad 1: /cerrar y /reenviar escriben, así que exigen el
  // token anti-CSRF en la cabecera.
  it('"Marcar como ganada" manda el token anti-CSRF en la cabecera', async () => {
    const { llamadas } = mockFetch();
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    await usuario.click(screen.getByRole('menuitem', { name: /marcar como ganada/i }));

    await waitFor(() => {
      const llamada = llamadas.find((l) => l.url.endsWith('/api/cotizacion/cerrar'));
      expect(llamada).toBeDefined();
      const cabeceras = new Headers(llamada!.init!.headers);
      expect(cabeceras.get('x-csrf-token')).toBe(CSRF_TOKEN);
    });
  });

  // Hallazgo importante del revisor: esta era la misma cabecera, en la
  // misma pantalla, sin la misma prueba — quitarle el token a `reenviar`
  // dejaba las 645 pruebas anteriores en verde. Dentro del iframe la sesión
  // es por cookie: sin este token, el servidor responde 401 y el vendedor
  // rebota a la pantalla de acceso cada vez que aprieta "Reenviar".
  //
  // Tarea 5 (usuarios del panel): las dos pruebas que antes vivían acá
  // ("Ganada"/"Reenviar" mandan la clave en el cuerpo, como respaldo de la
  // cookie) se retiran — no se convierten. Probaban que `cerrar()` y
  // `reenviar()` mandaban la clave compartida como respaldo de la cookie;
  // desde la Fase 3 (`autenticarPeticion`, lib/autenticacion-cotizador.ts)
  // el servidor ignora por completo cualquier `clave` en el cuerpo, así que
  // ese respaldo ya no existe y no hay nada equivalente que probar en su
  // lugar — la cookie más el token anti-CSRF son ahora la única credencial,
  // y eso ya lo cubren las pruebas de la cabecera `x-csrf-token`, abajo.
  it('"Reenviar" manda el token anti-CSRF en la cabecera', async () => {
    const { llamadas } = mockFetch();
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    await usuario.click(screen.getByRole('menuitem', { name: /reenviar/i }));

    await waitFor(() => {
      const llamada = llamadas.find((l) => l.url.endsWith('/api/cotizacion/reenviar'));
      expect(llamada).toBeDefined();
      const cabeceras = new Headers(llamada!.init!.headers);
      expect(cabeceras.get('x-csrf-token')).toBe(CSRF_TOKEN);
    });
  });

  it('"Marcar como perdida" pide el motivo antes de cerrar, y lo manda a /cerrar', async () => {
    const { llamadas } = mockFetch();
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    await usuario.click(screen.getByRole('menuitem', { name: /marcar como perdida/i }));

    // Sin motivo todavía: no puede confirmarse.
    const confirmar = await within(fila).findByRole('button', { name: /confirmar/i });
    expect(confirmar).toBeDisabled();
    expect(llamadas.some((l) => l.url.endsWith('/api/cotizacion/cerrar'))).toBe(false);

    await usuario.type(within(fila).getByLabelText(/motivo/i), 'Escogió a otro proveedor.');
    expect(confirmar).toBeEnabled();
    await usuario.click(confirmar);

    await waitFor(() => {
      const llamada = llamadas.find((l) => l.url.endsWith('/api/cotizacion/cerrar'));
      expect(llamada).toBeDefined();
      const cuerpo = JSON.parse(llamada!.init!.body as string);
      expect(cuerpo).toMatchObject({
        id: FILA_ABIERTA.id,
        estado: 'perdida',
        motivo: 'Escogió a otro proveedor.',
      });
    });
  });

  it('"Reenviar" llama a /reenviar y avisa del resultado', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    await usuario.click(screen.getByRole('menuitem', { name: /reenviar/i }));

    await waitFor(() => {
      expect(within(fila).getByText(/reenviado/i)).toBeInTheDocument();
    });
  });

  // El detalle del contrato que "muerde" si no se lee con cuidado: un 200
  // de /reenviar puede traer `actualizado: false` con un aviso adentro —
  // `res.ok` por sí solo no alcanza para saber que "todo salió perfecto".
  it('"Reenviar" avisa aunque la respuesta sea 200, si el registro no se pudo actualizar', async () => {
    mockFetch({
      reenviarRespuesta: {
        ok: true,
        resendId: 're_2',
        vencida: false,
        actualizado: false,
        avisoActualizacion: 'El correo se reenvió, pero no se pudo actualizar el registro. Actualizá la página.',
      },
    });
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    await usuario.click(screen.getByRole('menuitem', { name: /reenviar/i }));

    await waitFor(() => {
      expect(within(fila).getByText(/no se pudo actualizar el registro/i)).toBeInTheDocument();
    });
  });

  it('"Duplicar" lleva a la vista de crear con las líneas cargadas', async () => {
    mockFetch({ duplicarLineas: [{ skuId: 'set-600-king', cantidad: 12 }] });
    const usuario = userEvent.setup();
    const { onDuplicar } = renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    await usuario.click(screen.getByRole('menuitem', { name: /duplicar/i }));

    await waitFor(() => {
      expect(onDuplicar).toHaveBeenCalledWith({
        cliente: {
          nombre: 'Ana Pérez',
          empresa: 'Hotel Ana',
          email: 'ana@hotel.com',
          telefono: '',
          direccion: '',
        },
        lineas: [{ skuId: 'set-600-king', cantidad: 12 }],
      });
    });
  });

  // "Modificar" (migración 0016): mismo callback que "Duplicar" (ver el
  // comentario de `modificar()` en VistaListado.tsx), con tres datos de más
  // -- `reemplazaId`, `reemplazaNumero` y `contactId` -- que son justo los
  // que Panel/VistaCrear necesitan para reutilizar el contacto y enlazar
  // las dos filas al enviar.
  it('"Modificar" lleva a la vista de crear con las líneas cargadas y el vínculo a la cotización original', async () => {
    mockFetch({ duplicarLineas: [{ skuId: 'set-600-king', cantidad: 12 }] });
    const usuario = userEvent.setup();
    const { onDuplicar } = renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    await usuario.click(screen.getByRole('menuitem', { name: /modificar/i }));

    await waitFor(() => {
      expect(onDuplicar).toHaveBeenCalledWith({
        cliente: {
          nombre: 'Ana Pérez',
          empresa: 'Hotel Ana',
          email: 'ana@hotel.com',
          telefono: '',
          direccion: '',
        },
        lineas: [{ skuId: 'set-600-king', cantidad: 12 }],
        reemplazaId: FILA_ABIERTA.id,
        reemplazaNumero: FILA_ABIERTA.numero,
        contactId: FILA_ABIERTA.contact_id,
      });
    });
  });

  // ESTADOS_MODIFICABLES = ['creada', 'enviada'] -- 'ganada' queda afuera:
  // ver el comentario grande en app/api/cotizacion/route.ts para el
  // criterio completo.
  it('"Modificar" no aparece en una fila ganada', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/carla gómez/i)).toBeInTheDocument());
    const fila = screen.getByText(/carla gómez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    expect(screen.queryByRole('menuitem', { name: /modificar/i })).not.toBeInTheDocument();
    // El menú no queda vacío: "Duplicar" sigue disponible siempre.
    expect(screen.getByRole('menuitem', { name: /duplicar/i })).toBeInTheDocument();
  });

  // Una cotización ya reemplazada no se puede volver a modificar ni
  // reenviar -- ni siquiera cuando tiene `pdf_ruta` (el PDF vigente hoy es
  // el de la fila que la reemplazó, no el suyo).
  it('una fila reemplazada no ofrece "Modificar" ni "Reenviar", pero sí "Ver PDF" y "Duplicar"', async () => {
    mockFetch({ filas: [FILA_REEMPLAZADA] });
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/diana solís/i)).toBeInTheDocument());
    const fila = screen.getByText(/diana solís/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    expect(screen.queryByRole('menuitem', { name: /modificar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /reenviar/i })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /ver pdf/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /duplicar/i })).toBeInTheDocument();
  });

  // "Dejar rastro entre las dos" (encargo del dueño): el listado tiene que
  // mostrar la relación en las DOS filas, con el número de cotización -- lo
  // que el cliente cita por teléfono.
  it('muestra el rastro entre las dos cotizaciones, con su número, en las dos filas', async () => {
    mockFetch({ filas: [FILA_REEMPLAZADA, FILA_REEMPLAZO] });
    renderVista();

    await waitFor(() => expect(screen.getAllByText(/diana solís/i)).toHaveLength(2));
    const filaVieja = screen.getByText('COT-2026-0013').closest('tr') as HTMLElement;
    const filaNueva = screen.getByText('COT-2026-0014').closest('tr') as HTMLElement;

    expect(within(filaVieja).getByText(/reemplazada por cot-2026-0014/i)).toBeInTheDocument();
    expect(within(filaNueva).getByText(/reemplaza a cot-2026-0013/i)).toBeInTheDocument();
  });

  it('una fila sin ningún vínculo no muestra ningún aviso de reemplazo', async () => {
    mockFetch();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    expect(screen.queryByText(/reemplazada por/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/reemplaza a/i)).not.toBeInTheDocument();
  });

  // Ronda de correcciones final (hallazgo importante): el diseño lista cinco
  // acciones por fila y "ver el PDF" era la única que nunca se construyó —
  // hoy la única forma de ver un PDF ya guardado era reenviárselo al
  // cliente. Cuando un hotel llama preguntando por su cotización, el
  // vendedor no tenía forma de abrirla.
  it('"Ver PDF" pide el enlace firmado y lo abre en una pestaña nueva', async () => {
    mockFetch({ pdfUrl: 'https://firmada/cot-1.pdf' });
    const abrir = vi.spyOn(window, 'open').mockImplementation(() => null);
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    await usuario.click(screen.getByRole('menuitem', { name: /ver pdf/i }));

    await waitFor(() => {
      expect(abrir).toHaveBeenCalledWith('https://firmada/cot-1.pdf', '_blank', 'noopener,noreferrer');
    });
  });

  it('"Ver PDF" no aparece en una fila sin pdf_ruta', async () => {
    mockFetch({ filas: [{ ...FILA_ABIERTA, pdf_ruta: null }] });
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    expect(screen.queryByRole('menuitem', { name: /ver pdf/i })).not.toBeInTheDocument();
    // "Reenviar" depende de la misma condición (`pdf_ruta`) que "Ver PDF" --
    // sin PDF guardado, no hay nada que reenviar tampoco.
    expect(screen.queryByRole('menuitem', { name: /reenviar/i })).not.toBeInTheDocument();
    // El menú no queda vacío: "Duplicar" no depende de `pdf_ruta`.
    expect(screen.getByRole('menuitem', { name: /duplicar/i })).toBeInTheDocument();
  });

  it('un error al pedir el PDF se muestra en la fila, no se abre ninguna pestaña', async () => {
    mockFetch({ pdfStatus: 400, pdfError: 'Esta cotización no tiene un PDF guardado.' });
    const abrir = vi.spyOn(window, 'open').mockImplementation(() => null);
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    await usuario.click(screen.getByRole('menuitem', { name: /ver pdf/i }));

    await waitFor(() => {
      expect(within(fila).getByText(/no tiene un pdf guardado/i)).toBeInTheDocument();
    });
    expect(abrir).not.toHaveBeenCalled();
  });

  it('un 401 al ver el PDF llama a onSesionInvalida', async () => {
    mockFetch({ pdfStatus: 401 });
    const usuario = userEvent.setup();
    const { onSesionInvalida } = renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    await usuario.click(screen.getByRole('menuitem', { name: /ver pdf/i }));

    await waitFor(() => {
      expect(onSesionInvalida).toHaveBeenCalledTimes(1);
    });
  });

  // Ronda de correcciones final (hallazgo importante): el diseño promete
  // "las que fallaron, con su error" — antes la vista de fallidas mostraba
  // una píldora roja que decía "Error" y nada más, aunque `ghl_error` y
  // `motivo_cierre` ya viajaran al navegador en la misma respuesta.
  //
  // Ronda de correcciones 3 (hallazgo del dueño): antes el texto crudo del
  // servidor (`correo_error`/`ghl_error`) quedaba detrás de un botón "ver
  // detalle" (ver ronda 2 en el historial de este archivo). El dueño lo
  // vio y dijo que ni así -- "mi cliente no entiende nada de eso". El
  // detalle crudo se va de la pantalla del todo, no sólo se esconde: ya no
  // hay ningún control que lo revele. Esta prueba se adapta otra vez, no
  // se borra: sigue afirmando que el aviso humano llega solo, y ahora
  // suma que el texto crudo no aparece bajo ningún control posible.
  it('una fila en error muestra un aviso humano del correo, sin ningún control que revele el texto crudo', async () => {
    mockFetch({
      filas: [{ ...FILA_ABIERTA, estado: 'error', correo_error: 'Falta RESEND_API_KEY: no se pudo enviar el correo.' }],
    });
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());

    // El aviso humano está a la vista de entrada.
    expect(screen.getByText(/no le llegó el correo al cliente/i)).toBeInTheDocument();
    // El texto crudo del servidor no está a la vista, en ningún lado.
    expect(screen.queryByText(/falta resend_api_key/i)).not.toBeInTheDocument();
    // Tampoco escondido en un atributo (p. ej. `title`): `queryByText` sólo
    // mira texto, no atributos -- por eso se revisa el HTML entero acá.
    expect(document.body.innerHTML).not.toMatch(/falta resend_api_key/i);
    // Y no hay ningún control -- "ver detalle" u otro -- que lo revele: el
    // dato ya no vive en esta pantalla, ni siquiera detrás de un clic.
    expect(screen.queryByRole('button', { name: /ver detalle/i })).not.toBeInTheDocument();
  });

  it('una fila perdida muestra el motivo_cierre', async () => {
    mockFetch({
      filas: [{ ...FILA_GANADA, estado: 'perdida', motivo_cierre: 'Escogió a otro proveedor.' }],
    });
    renderVista();

    await waitFor(() => expect(screen.getByText(/carla gómez/i)).toBeInTheDocument());
    expect(screen.getByText(/escogió a otro proveedor/i)).toBeInTheDocument();
  });

  it('una fila con ghl_error muestra un aviso humano, distinto del error del correo, sin ningún control que revele el texto crudo', async () => {
    mockFetch({
      filas: [{ ...FILA_ABIERTA, ghl_error: 'GHL estimate 500: boom' }],
    });
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;

    // Aviso humano, distinto del de correo_error, a la vista de entrada --
    // y sin "GoHighLevel" ni "GHL": el CRM se llama Bralto para quien mira
    // la pantalla.
    expect(within(fila).getByText(/no se avisó al crm \(bralto\)/i)).toBeInTheDocument();
    expect(within(fila).queryByText(/no le llegó el correo al cliente/i)).not.toBeInTheDocument();
    // El texto crudo no está a la vista, en ningún lado.
    expect(within(fila).queryByText(/boom/i)).not.toBeInTheDocument();
    // Ni en un atributo (mismo hallazgo que el `title={detalle}` de antes):
    // se revisa el HTML de la fila entera, no sólo su texto.
    expect(fila.innerHTML).not.toMatch(/boom/i);
    // Y no hay ningún control que lo revele -- el detalle crudo ya no vive
    // en esta pantalla, ni siquiera detrás de un clic.
    expect(within(fila).queryByRole('button', { name: /ver detalle/i })).not.toBeInTheDocument();
  });

  // Ancla lo esencial del pedido del dueño: la respuesta cruda del
  // servidor no puede aparecer en pantalla bajo ningún camino -- ni visible
  // de entrada, ni detrás de un control, ni en un atributo -- y tiene que
  // haber un aviso en español de que algo falló. Se prueba con las dos
  // fallas por separado (correo/CRM) para que ninguna de las dos pueda
  // quedar en silencio.
  it('el texto crudo del servidor nunca está a la vista, bajo ningún camino -- siempre hay un aviso humano primero', async () => {
    mockFetch({
      filas: [
        {
          ...FILA_ABIERTA,
          estado: 'error',
          correo_error: 'GHL workflow 422: {"status":422,"message":"timezone offset","traceId":"abc-123"}',
          ghl_error: 'GHL workflow 422: {"status":422,"message":"timezone offset","traceId":"abc-123"}',
        },
      ],
    });
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());

    // El JSON crudo no aparece en ningún lado de la pantalla.
    expect(screen.queryByText(/traceId/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/timezone offset/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/"status":422/i)).not.toBeInTheDocument();
    // Tampoco en ningún atributo (`title` y similares): `queryByText` no
    // los mira, así que hace falta revisar el HTML servido de punta a
    // punta para que "ningún lado de la pantalla" sea cierto de verdad.
    expect(document.body.innerHTML).not.toMatch(/traceId/i);
    expect(document.body.innerHTML).not.toMatch(/timezone offset/i);
    expect(document.body.innerHTML).not.toMatch(/"status":422/i);
    // Ni hay ningún control -- "ver detalle" ni ningún otro -- capaz de
    // revelarlo: el dueño pidió que se fuera de la pantalla del todo, no
    // que se escondiera mejor.
    expect(screen.queryByRole('button', { name: /ver detalle/i })).not.toBeInTheDocument();

    // Pero sí hay, sin pedir nada, un aviso en español de que algo falló.
    expect(screen.getByText(/no le llegó el correo al cliente/i)).toBeInTheDocument();
    expect(screen.getByText(/no se avisó al crm/i)).toBeInTheDocument();
  });

  // El dueño paga la marca blanca de GoHighLevel: en pantalla el CRM se
  // llama "Bralto" -- la etiqueta que lee el vendedor no puede decir
  // "GoHighLevel". El dominio del enlace lo manda el servidor
  // (`crmDominio`, ver app/api/cotizacion/listado/route.ts); sin ese campo
  // en la respuesta (como acá, con `mockFetch()` sin `crmDominio`) el
  // componente usa el mismo default que el servidor -- `app.gohighlevel.com`
  // -- nunca un dominio hardcodeado aparte en el propio componente.
  it('hay un enlace a la ficha del contacto en Bralto cuando la fila tiene contact_id', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const filaConContacto = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, filaConContacto);
    const enlace = screen.getByRole('menuitem', { name: /bralto/i });
    expect(enlace).toHaveAttribute(
      'href',
      `https://app.gohighlevel.com/v2/location/${LOCATION_ID}/contacts/detail/${FILA_ABIERTA.contact_id}`,
    );
    await usuario.keyboard('{Escape}');

    // La fila sin `contact_id` (FILA_POR_VENCER) no lleva ese enlace.
    const filaSinContacto = screen.getByText(/beto ruiz/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, filaSinContacto);
    expect(screen.queryByRole('menuitem', { name: /bralto/i })).not.toBeInTheDocument();
  });

  // Hallazgo (tarea del dominio de Bralto): el enlace tiene que seguir al
  // dominio que manda el servidor, no quedar pegado al default. Esta
  // prueba es la que se rompe si alguien vuelve a hardcodear
  // `app.gohighlevel.com` en VistaListado.tsx en vez de leer `crmDominio`
  // de la respuesta de `/listado`.
  it('usa el crmDominio que manda el servidor para el enlace a Bralto, cuando viene distinto del default', async () => {
    mockFetch({ crmDominio: 'app.bralto.io' });
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const filaConContacto = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, filaConContacto);
    const enlace = screen.getByRole('menuitem', { name: /bralto/i });
    expect(enlace).toHaveAttribute(
      'href',
      `https://app.bralto.io/v2/location/${LOCATION_ID}/contacts/detail/${FILA_ABIERTA.contact_id}`,
    );
  });

  it('sin cotizaciones, un texto neutro', async () => {
    mockFetch({ filas: [] });
    renderVista();

    await waitFor(() => {
      expect(screen.getByText(/no hay cotizaciones/i)).toBeInTheDocument();
    });
  });

  // Regla de seguridad 2: un 401 devuelve al vendedor a la pantalla de
  // clave sin perder lo que armó — `Panel` ya tiene ese mecanismo
  // (`onSesionInvalida`); esta pantalla lo usa, no inventa uno nuevo.
  it('un 401 al cerrar llama a onSesionInvalida', async () => {
    mockFetch({ cerrarStatus: 401, cerrarError: 'Token anti-CSRF inválido.' });
    const usuario = userEvent.setup();
    const { onSesionInvalida } = renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    await usuario.click(screen.getByRole('menuitem', { name: /marcar como ganada/i }));

    await waitFor(() => {
      expect(onSesionInvalida).toHaveBeenCalledTimes(1);
    });
  });

  // Hallazgo importante del revisor: la regla de "un 401 vuelve a la
  // pantalla de clave sin perder el trabajo" se sostenía sobre UNA sola
  // prueba (la de arriba, sobre /cerrar). Quitarle el manejo del 401 a
  // /listado o a /reenviar no rompía nada — acá van sus gemelas.
  it('un 401 al listar llama a onSesionInvalida', async () => {
    mockFetch({ listado401: true });
    const { onSesionInvalida } = renderVista();

    await waitFor(() => {
      expect(onSesionInvalida).toHaveBeenCalledTimes(1);
    });
  });

  it('un 401 al reenviar llama a onSesionInvalida', async () => {
    mockFetch({ reenviarStatus: 401 });
    const usuario = userEvent.setup();
    const { onSesionInvalida } = renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    await usuario.click(screen.getByRole('menuitem', { name: /reenviar/i }));

    await waitFor(() => {
      expect(onSesionInvalida).toHaveBeenCalledTimes(1);
    });
  });

  it('un 401 al duplicar llama a onSesionInvalida', async () => {
    mockFetch({ duplicarStatus: 401 });
    const usuario = userEvent.setup();
    const { onSesionInvalida, onDuplicar } = renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    await usuario.click(screen.getByRole('menuitem', { name: /duplicar/i }));

    await waitFor(() => {
      expect(onSesionInvalida).toHaveBeenCalledTimes(1);
    });
    expect(onDuplicar).not.toHaveBeenCalled();
  });

  // El resaltado de las que vencen (aviso #2 del brief anterior: "tienen
  // que saltar a la vista") no estaba defendido por ninguna prueba: se
  // podía dejar la fila idéntica a las demás y las 12 de antes seguían
  // verdes, porque solo se afirmaba el texto "Vence en N días", nunca que
  // se distinguiera visualmente.
  it('la fila que vence pronto se distingue visualmente de las que no', async () => {
    mockFetch();
    renderVista();

    await waitFor(() => expect(screen.getByText(/beto ruiz/i)).toBeInTheDocument());
    const filaPorVencer = screen.getByText(/beto ruiz/i).closest('tr') as HTMLElement;
    const filaNormal = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;

    expect(filaPorVencer.className).not.toBe(filaNormal.className);
    expect(filaPorVencer.className.length).toBeGreaterThan(0);
  });

  // "Por vencer": recorta la lista a lo que de verdad hay que llamar hoy,
  // sin depender del resaltado para encontrarlo entre hasta 200 filas.
  it('el filtro "Por vencer" no manda estado al servidor y solo muestra las próximas a vencer', async () => {
    const { llamadas } = mockFetch();
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    await usuario.selectOptions(screen.getByLabelText(/filtrar por estado/i), 'Por vencer');

    await waitFor(() => {
      expect(screen.getByText(/beto ruiz/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/ana pérez/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/carla gómez/i)).not.toBeInTheDocument();

    const ultima = llamadas.filter((l) => l.url.endsWith('/api/cotizacion/listado')).at(-1);
    expect(ultima).toBeDefined();
    const cuerpo = JSON.parse((ultima!.init!.body as string) ?? '{}');
    expect(cuerpo.estado).toBeUndefined();
  });

  // El mensaje de una acción anterior ("Reenviado.", o un error) no debe
  // sobrevivir a un cambio de filtro: ni la fila a la que pertenecía sigue
  // necesariamente visible ahí.
  it('los mensajes de una fila se limpian al cambiar el filtro, aunque la fila siga visible', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    await usuario.click(screen.getByRole('menuitem', { name: /reenviar/i }));
    await waitFor(() => expect(within(fila).getByText(/reenviado/i)).toBeInTheDocument());

    // Filtra por el propio estado de la fila de Ana ('enviada'): sigue
    // visible después del filtro — así el mensaje desaparecido se debe de
    // verdad a la limpieza, no a que la fila se haya ido con el filtro.
    await usuario.selectOptions(screen.getByLabelText(/filtrar por estado/i), 'enviada');
    await waitFor(() => {
      expect(screen.getByText(/ana pérez/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/reenviado/i)).not.toBeInTheDocument();
  });

  // Ronda de correcciones (hallazgo del dueño): el CRM se llama "Bralto" en
  // todo lo que ve un vendedor -- el dueño paga la marca blanca de
  // GoHighLevel y no quiere que el nombre del proveedor real aparezca en
  // ningún texto legible de la pantalla. El dominio del enlace "Ver en
  // Bralto" no cuenta -- es una URL, no texto que alguien lea -- por eso
  // esta prueba mira `textContent` (lo que de verdad se ve), no el HTML
  // completo.
  it('ningún texto visible de la pantalla dice "GoHighLevel" ni "GHL"', async () => {
    mockFetch({
      filas: [
        { ...FILA_ABIERTA, ghl_error: 'GHL estimate 500: boom' },
        { ...FILA_POR_VENCER, estado: 'error', correo_error: 'GHL workflow 422: falla' },
      ],
    });
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    // Abre el menú de la fila con contact_id + locationId para que "Ver en
    // Bralto" también entre al DOM -- si no se abriera, esa etiqueta ni
    // siquiera se pintaría, y la prueba no diría nada sobre ella.
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await abrirMenu(usuario, fila);
    expect(screen.getByRole('menuitem', { name: /bralto/i })).toBeInTheDocument();

    expect(document.body.textContent).not.toMatch(/gohighlevel/i);
    expect(document.body.textContent).not.toMatch(/\bghl\b/i);
  });

  // Hallazgo del dueño: sin la columna "Acciones" ni "Ganada"/"Perdida"
  // sueltos, el único control de la fila es el botón de tres puntos -- ya
  // no necesita parecer un botón.
  it('el botón de tres puntos no tiene aspecto de botón, pero indica que se puede clicar al pasar el mouse o enfocar, y tiene nombre accesible', async () => {
    mockFetch();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    const boton = within(fila).getByRole('button', { name: /más acciones/i });

    // Tres puntos en vertical, nada más como texto visible.
    expect(boton.textContent).toBe('⋮');
    // Nombre accesible aunque no tenga texto visible.
    expect(boton).toHaveAccessibleName('Más acciones para Ana Pérez');
    // Sin aspecto de botón en reposo: nada de borde ni fondo.
    expect(boton.className).not.toMatch(/\bborder\b/);
    expect(boton.className).not.toMatch(/\bbg-/);
    // Pero sí cambia al pasar el mouse o enfocar con teclado -- si no,
    // nada le avisaría a alguien que ese texto se puede clicar.
    expect(boton.className).toMatch(/hover:/);
    expect(boton.className).toMatch(/focus-visible:/);
  });

  // Hallazgo del dueño: "no hay encabezado ni columna con nombre" -- sólo
  // los tres puntos, al final de cada fila.
  it('la columna del botón de tres puntos no tiene un encabezado con nombre', async () => {
    mockFetch();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    expect(screen.queryByText(/^acciones$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /acciones/i })).not.toBeInTheDocument();
  });

  // Hallazgo del dueño: "COT-2026-0012" se partía en dos o tres renglones
  // en la columna "Número". `whitespace-nowrap` (el mismo recurso que ya
  // usa Cliente) es lo que en un navegador de verdad evita el corte --
  // jsdom no hace layout, así que la única forma de anclar esto es
  // afirmar que la clase está puesta.
  it('el número de cotización no se corta en varios renglones', async () => {
    mockFetch();
    renderVista();

    const celda = await screen.findByText('COT-2026-0010');
    expect(celda.tagName).toBe('TD');
    expect(celda.className).toMatch(/whitespace-nowrap/);
  });

  // El menú de tres puntos (Marcar como ganada/Marcar como perdida/Ver
  // PDF/Reenviar/Duplicar/Ver en Bralto) es el único control por fila: los
  // atributos de accesibilidad de un menú, y las tres formas en que "se
  // espera" que se cierre.
  describe('menú de acciones', () => {
    it('el botón lleva aria-haspopup y aria-expanded, y el panel es un role="menu"', async () => {
      mockFetch();
      const usuario = userEvent.setup();
      renderVista();

      await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
      const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
      const boton = within(fila).getByRole('button', { name: /más acciones/i });
      expect(boton).toHaveAttribute('aria-haspopup', 'menu');
      expect(boton).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();

      await usuario.click(boton);

      expect(boton).toHaveAttribute('aria-expanded', 'true');
      const menu = screen.getByRole('menu');
      expect(menu).toBeInTheDocument();
      // `aria-controls` en el botón tiene que apuntar al panel que abre --
      // es lo que le dice a un lector de pantalla que ambos van juntos.
      expect(boton).toHaveAttribute('aria-controls', menu.id);
    });

    // Hallazgo del dueño (ronda de correcciones): la fila ya no tiene NINGÚN
    // botón suelto -- "Ganada"/"Perdida" se mudaron adentro del menú, junto
    // con el resto ("Modificar" sigue apareciendo porque `FILA_ABIERTA`
    // está en 'enviada', dentro de ESTADOS_MODIFICABLES). Van primero en la
    // lista -- son la decisión más frecuente.
    it('el menú lista las siete acciones, con "Marcar como ganada"/"Marcar como perdida" primero, y la fila no tiene ningún botón suelto', async () => {
      mockFetch();
      const usuario = userEvent.setup();
      renderVista();

      await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
      const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
      // Ni "Ganada"/"Perdida" ni ningún otro botón viven sueltos en la fila
      // -- el único control ahí es el de tres puntos que abre el menú.
      expect(within(fila).queryByRole('button', { name: /^ganada$/i })).not.toBeInTheDocument();
      expect(within(fila).queryByRole('button', { name: /^perdida$/i })).not.toBeInTheDocument();
      expect(within(fila).getAllByRole('button')).toHaveLength(1);

      await abrirMenu(usuario, fila);
      const items = screen.getAllByRole('menuitem').map((el) => el.textContent);
      expect(items).toEqual([
        'Marcar como ganada',
        'Marcar como perdida',
        'Ver PDF',
        'Reenviar',
        'Duplicar',
        'Modificar',
        'Ver en Bralto',
      ]);
    });

    it('Escape cierra el menú y devuelve el foco al botón de tres puntos', async () => {
      mockFetch();
      const usuario = userEvent.setup();
      renderVista();

      await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
      const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
      const boton = within(fila).getByRole('button', { name: /más acciones/i });
      await abrirMenu(usuario, fila);
      expect(screen.getByRole('menu')).toBeInTheDocument();

      await usuario.keyboard('{Escape}');

      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(boton).toHaveAttribute('aria-expanded', 'false');
      expect(boton).toHaveFocus();
    });

    it('un clic fuera del menú lo cierra', async () => {
      mockFetch();
      const usuario = userEvent.setup();
      renderVista();

      await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
      const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
      await abrirMenu(usuario, fila);
      expect(screen.getByRole('menu')).toBeInTheDocument();

      // Clic en un rincón de la página que no es ni el botón ni el menú --
      // el encabezado del filtro, por ejemplo.
      await usuario.click(screen.getByLabelText(/filtrar por estado/i));

      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('Tab se sale del menú y lo cierra, en vez de dejarlo flotando sin nada enfocado', async () => {
      mockFetch();
      const usuario = userEvent.setup();
      renderVista();

      await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
      const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
      await abrirMenu(usuario, fila);
      expect(screen.getByRole('menu')).toBeInTheDocument();

      await usuario.tab();

      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('elegir una opción del menú lo cierra', async () => {
      mockFetch({ duplicarLineas: [] });
      const usuario = userEvent.setup();
      renderVista();

      await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
      const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
      await abrirMenu(usuario, fila);
      await usuario.click(screen.getByRole('menuitem', { name: /duplicar/i }));

      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('el foco cae en el primer ítem al abrir, y las flechas navegan entre ítems', async () => {
      mockFetch();
      const usuario = userEvent.setup();
      renderVista();

      await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
      const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
      await abrirMenu(usuario, fila);

      // Siete ítems, con "Ganada"/"Perdida" primero: Marcar como ganada,
      // Marcar como perdida, Ver PDF, Reenviar, Duplicar, Modificar, Ver en
      // Bralto.
      const items = screen.getAllByRole('menuitem');
      expect(items[0]).toHaveFocus(); // "Marcar como ganada"

      await usuario.keyboard('{ArrowDown}');
      expect(items[1]).toHaveFocus(); // "Marcar como perdida"

      await usuario.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
      expect(items[6]).toHaveFocus(); // "Ver en Bralto"

      // Cierra el ciclo: de la última vuelve a la primera.
      await usuario.keyboard('{ArrowDown}');
      expect(items[0]).toHaveFocus();

      await usuario.keyboard('{ArrowUp}');
      expect(items[6]).toHaveFocus(); // vuelve a la última
    });

    it('abrir el menú de otra fila cierra el de la fila anterior', async () => {
      mockFetch();
      const usuario = userEvent.setup();
      renderVista();

      await waitFor(() => expect(screen.getByText(/beto ruiz/i)).toBeInTheDocument());
      const filaAna = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
      const filaBeto = screen.getByText(/beto ruiz/i).closest('tr') as HTMLElement;

      await abrirMenu(usuario, filaAna);
      expect(screen.getByRole('menu')).toHaveAttribute('aria-label', 'Más acciones para Ana Pérez');

      await abrirMenu(usuario, filaBeto);

      expect(screen.getAllByRole('menu')).toHaveLength(1);
      expect(screen.getByRole('menu')).toHaveAttribute('aria-label', 'Más acciones para Beto Ruiz');
    });

    // El riesgo concreto del pedido: el panel vive en un iframe angosto de
    // GoHighLevel, y la tabla ya tiene su propio scroll horizontal. jsdom no
    // hace layout de verdad (todo `getBoundingClientRect` da ceros por
    // defecto), así que sin este `mockReturnValue` el cálculo de
    // `ubicar()` nunca ejercita la rama que evita el corte -- queda sin
    // ninguna prueba detrás. Se simula el botón pegado al borde derecho de
    // una ventana de 375px (ancho típico de un iframe embebido) para que
    // el menú, de 208px, sí necesite correrse hacia la izquierda.
    it('el menú no se corta contra el borde derecho de una ventana angosta', async () => {
      mockFetch();
      const usuario = userEvent.setup();
      const anchoOriginal = window.innerWidth;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
      renderVista();

      await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
      const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
      const boton = within(fila).getByRole('button', { name: /más acciones/i });
      vi.spyOn(boton, 'getBoundingClientRect').mockReturnValue({
        top: 100,
        bottom: 120,
        left: 340,
        right: 370,
        width: 30,
        height: 20,
        x: 340,
        y: 100,
        toJSON() {},
      } as DOMRect);

      await usuario.click(boton);

      const menu = screen.getByRole('menu');
      const left = parseFloat(menu.style.left);
      const ANCHO_MENU = 208;
      // Ni pegado contra el borde izquierdo de la ventana...
      expect(left).toBeGreaterThanOrEqual(8);
      // ...ni saliéndose por el derecho -- que es justo lo que pasaba antes
      // de que `ubicar()` recalculara el lado.
      expect(left + ANCHO_MENU).toBeLessThanOrEqual(375 - 8);

      Object.defineProperty(window, 'innerWidth', { configurable: true, value: anchoOriginal });
    });

    // Complementa la prueba anterior: cuando el botón NO está pegado al
    // borde derecho pero el menú tampoco entra "colgando hacia la
    // izquierda" desde su borde derecho (una columna angosta a media
    // tabla), `ubicar()` lo alinea con el borde IZQUIERDO del botón en vez
    // de aplastarlo contra el margen mínimo de la ventana -- que quedaría
    // lejos del botón que lo abrió.
    it('si no cae colgando hacia la izquierda, el menú se alinea con el borde izquierdo del botón', async () => {
      mockFetch();
      const usuario = userEvent.setup();
      renderVista();

      await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
      const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
      const boton = within(fila).getByRole('button', { name: /más acciones/i });
      // rect.right - 208 (ancho del menú) da negativo -- no alcanza colgando
      // a la izquierda -- pero el botón no está para nada cerca del borde
      // de la ventana (rect.left = 100, ventana de 800px de ancho).
      vi.spyOn(boton, 'getBoundingClientRect').mockReturnValue({
        top: 100,
        bottom: 120,
        left: 100,
        right: 140,
        width: 40,
        height: 20,
        x: 100,
        y: 100,
        toJSON() {},
      } as DOMRect);

      await usuario.click(boton);

      const menu = screen.getByRole('menu');
      expect(parseFloat(menu.style.left)).toBe(100);
    });

    // Caso extremo pero real dentro de un iframe: una ventana más angosta
    // que el propio menú (208px) más sus dos márgenes. El clamp por la
    // derecha por sí solo empujaría el menú a un `left` negativo -- fuera
    // de la ventana por la izquierda. El último clamp lo trae de vuelta al
    // margen mínimo en vez de dejarlo cortado.
    it('en una ventana más angosta que el propio menú, no lo empuja a un left negativo', async () => {
      mockFetch();
      const usuario = userEvent.setup();
      const anchoOriginal = window.innerWidth;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 180 });
      renderVista();

      await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
      const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
      const boton = within(fila).getByRole('button', { name: /más acciones/i });
      vi.spyOn(boton, 'getBoundingClientRect').mockReturnValue({
        top: 100,
        bottom: 120,
        left: 150,
        right: 170,
        width: 20,
        height: 20,
        x: 150,
        y: 100,
        toJSON() {},
      } as DOMRect);

      await usuario.click(boton);

      const menu = screen.getByRole('menu');
      expect(parseFloat(menu.style.left)).toBe(8);

      Object.defineProperty(window, 'innerWidth', { configurable: true, value: anchoOriginal });
    });
  });
});
