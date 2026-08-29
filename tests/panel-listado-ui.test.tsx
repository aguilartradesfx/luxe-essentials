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
      return new Response(JSON.stringify({ ok: true, cotizaciones: filtradas, locationId: LOCATION_ID }), {
        status: 200,
      });
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

  it('"Ganada" llama a /cerrar con el estado correcto', async () => {
    const { llamadas } = mockFetch();
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => {
      expect(screen.getByText(/ana pérez/i)).toBeInTheDocument();
    });
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await usuario.click(within(fila).getByRole('button', { name: /^ganada$/i }));

    await waitFor(() => {
      const llamada = llamadas.find((l) => l.url.endsWith('/api/cotizacion/cerrar'));
      expect(llamada).toBeDefined();
      const cuerpo = JSON.parse(llamada!.init!.body as string);
      expect(cuerpo).toMatchObject({ id: FILA_ABIERTA.id, estado: 'ganada' });
    });
  });

  // Regla de seguridad 1: /cerrar y /reenviar escriben, así que exigen el
  // token anti-CSRF en la cabecera.
  it('"Ganada" manda el token anti-CSRF en la cabecera', async () => {
    const { llamadas } = mockFetch();
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await usuario.click(within(fila).getByRole('button', { name: /^ganada$/i }));

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
    await usuario.click(within(fila).getByRole('button', { name: /reenviar/i }));

    await waitFor(() => {
      const llamada = llamadas.find((l) => l.url.endsWith('/api/cotizacion/reenviar'));
      expect(llamada).toBeDefined();
      const cabeceras = new Headers(llamada!.init!.headers);
      expect(cabeceras.get('x-csrf-token')).toBe(CSRF_TOKEN);
    });
  });

  it('"Perdida" pide el motivo antes de cerrar, y lo manda a /cerrar', async () => {
    const { llamadas } = mockFetch();
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await usuario.click(within(fila).getByRole('button', { name: /^perdida$/i }));

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
    await usuario.click(within(fila).getByRole('button', { name: /reenviar/i }));

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
    await usuario.click(within(fila).getByRole('button', { name: /reenviar/i }));

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
    await usuario.click(within(fila).getByRole('button', { name: /duplicar/i }));

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
    await usuario.click(within(fila).getByRole('button', { name: /ver pdf/i }));

    await waitFor(() => {
      expect(abrir).toHaveBeenCalledWith('https://firmada/cot-1.pdf', '_blank', 'noopener,noreferrer');
    });
  });

  it('"Ver PDF" no aparece en una fila sin pdf_ruta', async () => {
    mockFetch({ filas: [{ ...FILA_ABIERTA, pdf_ruta: null }] });
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    expect(within(fila).queryByRole('button', { name: /ver pdf/i })).not.toBeInTheDocument();
  });

  it('un error al pedir el PDF se muestra en la fila, no se abre ninguna pestaña', async () => {
    mockFetch({ pdfStatus: 400, pdfError: 'Esta cotización no tiene un PDF guardado.' });
    const abrir = vi.spyOn(window, 'open').mockImplementation(() => null);
    const usuario = userEvent.setup();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const fila = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    await usuario.click(within(fila).getByRole('button', { name: /ver pdf/i }));

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
    await usuario.click(within(fila).getByRole('button', { name: /ver pdf/i }));

    await waitFor(() => {
      expect(onSesionInvalida).toHaveBeenCalledTimes(1);
    });
  });

  // Ronda de correcciones final (hallazgo importante): el diseño promete
  // "las que fallaron, con su error" — antes la vista de fallidas mostraba
  // una píldora roja que decía "Error" y nada más, aunque `ghl_error` y
  // `motivo_cierre` ya viajaran al navegador en la misma respuesta.
  it('una fila en error muestra el error del correo (correo_error), no solo la palabra "Error"', async () => {
    mockFetch({
      filas: [{ ...FILA_ABIERTA, estado: 'error', correo_error: 'Falta RESEND_API_KEY: no se pudo enviar el correo.' }],
    });
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    expect(screen.getByText(/falta resend_api_key/i)).toBeInTheDocument();
  });

  it('una fila perdida muestra el motivo_cierre', async () => {
    mockFetch({
      filas: [{ ...FILA_GANADA, estado: 'perdida', motivo_cierre: 'Escogió a otro proveedor.' }],
    });
    renderVista();

    await waitFor(() => expect(screen.getByText(/carla gómez/i)).toBeInTheDocument());
    expect(screen.getByText(/escogió a otro proveedor/i)).toBeInTheDocument();
  });

  it('una fila con ghl_error lo muestra, aparte del error del correo', async () => {
    mockFetch({
      filas: [{ ...FILA_ABIERTA, ghl_error: 'GHL estimate 500: boom' }],
    });
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    expect(screen.getByText(/boom/i)).toBeInTheDocument();
  });

  it('hay un enlace a la ficha del contacto en GoHighLevel cuando la fila tiene contact_id', async () => {
    mockFetch();
    renderVista();

    await waitFor(() => expect(screen.getByText(/ana pérez/i)).toBeInTheDocument());
    const filaConContacto = screen.getByText(/ana pérez/i).closest('tr') as HTMLElement;
    const enlace = within(filaConContacto).getByRole('link', { name: /gohighlevel/i });
    expect(enlace).toHaveAttribute(
      'href',
      `https://app.gohighlevel.com/v2/location/${LOCATION_ID}/contacts/detail/${FILA_ABIERTA.contact_id}`,
    );

    // La fila sin `contact_id` (FILA_POR_VENCER) no lleva ese enlace.
    const filaSinContacto = screen.getByText(/beto ruiz/i).closest('tr') as HTMLElement;
    expect(within(filaSinContacto).queryByRole('link', { name: /gohighlevel/i })).not.toBeInTheDocument();
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
    await usuario.click(within(fila).getByRole('button', { name: /^ganada$/i }));

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
    await usuario.click(within(fila).getByRole('button', { name: /reenviar/i }));

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
    await usuario.click(within(fila).getByRole('button', { name: /duplicar/i }));

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
    await usuario.click(within(fila).getByRole('button', { name: /reenviar/i }));
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
});
