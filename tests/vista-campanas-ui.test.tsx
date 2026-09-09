import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Cotizador from '@/app/cotizador/Panel';
import { VistaCampanas } from '@/app/cotizador/VistaCampanas';

// Bandeja de campañas (parte 2): la pestaña "Campañas". Mismo criterio de
// dos niveles que tests/equipo-ui.test.tsx y tests/vista-aprobaciones-ui.test.tsx:
//
// 1. `describe('Panel — pestaña campañas')` monta `Panel` entero para
//    comprobar que el botón se dibuja o no según el `rol`.
// 2. `describe('VistaCampanas')` monta el componente solo, con las siete
//    rutas de app/api/campanas/* mockeadas. La prueba que más importa de
//    este archivo es la del bloque "selección: página vs. zona" -- que los
//    dos botones produzcan cantidades DISTINTAS y visibles, porque es el
//    escenario que el diseño pide que sea imposible de confundir.

const CSRF_TOKEN = 'csrf-de-prueba';

function mockFetchPanel(opciones: { rol: 'vendedor' | 'superadmin' }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/cotizacion/catalogo')) {
      return new Response(
        JSON.stringify({ ok: true, skus: [], csrf: CSRF_TOKEN, vendedor: 'Ana Solano', rol: opciones.rol }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/cotizacion/borradores')) {
      return new Response(JSON.stringify({ ok: true, borradores: [] }), { status: 200 });
    }
    throw new Error(`Fetch no simulado en la prueba: ${url}`);
  });
}

describe('Panel — pestaña campañas', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no muestra la pestaña de campañas a un vendedor', async () => {
    mockFetchPanel({ rol: 'vendedor' });
    render(<Cotizador />);
    await waitFor(() => {
      expect(screen.getByText(/sesión de ana solano/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^campañas$/i })).not.toBeInTheDocument();
  });

  it('la muestra a un superadmin', async () => {
    mockFetchPanel({ rol: 'superadmin' });
    render(<Cotizador />);
    expect(await screen.findByRole('button', { name: /^campañas$/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------

const PLANTILLAS_RESPUESTA = [
  { plantilla: 'inicial', asunto: 'Asunto inicial', previewText: 'Vista previa inicial', parrafos: ['Uno.', 'Dos.', 'Tres.'] },
  { plantilla: 'seguimiento_1', asunto: 'Asunto s1', previewText: 'Vista s1', parrafos: ['A.', 'B.', 'C.', 'D.'] },
  { plantilla: 'seguimiento_2', asunto: 'Asunto s2', previewText: 'Vista s2', parrafos: ['X.', 'Y.', 'Z.'] },
  { plantilla: 'seguimiento_3', asunto: 'Asunto s3', previewText: 'Vista s3', parrafos: ['P.', 'Q.', 'R.'] },
];

// 30 contactos: los primeros 28 con correo, los últimos 2 sin correo -- de
// forma que la primera página (20, tamaño por defecto) esté ENTERA
// compuesta por contactos con correo, y "toda la zona" (28) sea un número
// bien distinto de "esta página" (20).
function contactosDeZona(zona: string) {
  return Array.from({ length: 30 }, (_, i) => ({
    contactId: `${zona}-c${i}`,
    nombreCrm: `Hotel ${zona} ${i}`,
    correo: i < 28 ? `c${i}@${zona.replace(/\s+/g, '').toLowerCase()}.cr` : null,
  }));
}

function mockFetchCampanas(
  opciones: {
    listado?: unknown[];
    onCrear?: (cuerpo: any) => void;
    onEnviar?: (cuerpo: any) => void;
    enviarSecuencia?: Array<{ procesados: number; enviados: number; fallidos: number; terminada: boolean }>;
  } = {},
) {
  let llamadasEnviar = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const cuerpo = init?.body ? JSON.parse(init.body as string) : {};

    if (url.endsWith('/api/campanas/zonas')) {
      return new Response(
        JSON.stringify({
          ok: true,
          zonas: [
            { zona: 'GAM Oeste', total: 30, conCorreo: 28 },
            { zona: 'GAM Centro', total: 5, conCorreo: 5 },
            { zona: 'GAM Este / Cartago', total: 0, conCorreo: 0 },
            { zona: 'Heredia / Norte GAM', total: 0, conCorreo: 0 },
            { zona: 'Alajuela / Occidente', total: 0, conCorreo: 0 },
            { zona: 'Zona Norte', total: 0, conCorreo: 0 },
            { zona: 'Guanacaste Costa', total: 0, conCorreo: 0 },
            { zona: 'Guanacaste Interior', total: 27, conCorreo: 27 },
            { zona: 'Península Nicoya', total: 0, conCorreo: 0 },
            { zona: 'Pacífico Central', total: 0, conCorreo: 0 },
            { zona: 'Pacífico Sur', total: 0, conCorreo: 0 },
            { zona: 'Caribe', total: 0, conCorreo: 0 },
            { zona: 'Revisión manual', total: 0, conCorreo: 0 },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/campanas/contactos')) {
      const contactos = contactosDeZona(cuerpo.zona);
      return new Response(
        JSON.stringify({ ok: true, contactos, total: contactos.length, conCorreo: 28 }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/campanas/plantillas')) {
      return new Response(JSON.stringify({ ok: true, plantillas: PLANTILLAS_RESPUESTA }), { status: 200 });
    }
    if (url.endsWith('/api/campanas/listado')) {
      return new Response(JSON.stringify({ ok: true, campanas: opciones.listado ?? [] }), { status: 200 });
    }
    if (url.endsWith('/api/campanas/previsualizar')) {
      const esPersonalizada = cuerpo.plantilla === 'personalizada';
      return new Response(
        JSON.stringify({
          ok: true,
          asunto: esPersonalizada ? cuerpo.asunto : 'Asunto inicial',
          previewText: esPersonalizada ? cuerpo.previewText : 'preview',
          html: esPersonalizada ? `<p>vista previa de: ${cuerpo.html}</p>` : '<p>hola</p>',
          advertencias: esPersonalizada ? ['Se quitó 1 etiqueta <script>.'] : undefined,
          // Firma "de mentira" -- alcanza con que sea determinística sobre
          // asunto+html para que las pruebas de abajo puedan comprobar que
          // `POST /api/campanas/crear` recibe la firma que le devolvió ESTA
          // previsualización, y ninguna otra.
          firmaPrevisualizacion: esPersonalizada ? `firma(${cuerpo.asunto}|${cuerpo.html})` : undefined,
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/campanas/crear')) {
      opciones.onCrear?.(cuerpo);
      return new Response(
        JSON.stringify({ ok: true, campanaId: 'camp-1', destinatarios: cuerpo.seleccion === 'zona' ? 28 : (cuerpo.contactIds?.length ?? 0), excluidosPorBaja: 0 }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/campanas/enviar')) {
      opciones.onEnviar?.(cuerpo);
      const secuencia = opciones.enviarSecuencia ?? [{ procesados: 1, enviados: 1, fallidos: 0, terminada: true }];
      const resultado = secuencia[Math.min(llamadasEnviar, secuencia.length - 1)];
      llamadasEnviar++;
      return new Response(JSON.stringify({ ok: true, ...resultado }), { status: 200 });
    }
    throw new Error(`Fetch no simulado en la prueba: ${url}`);
  });
}

function obtenerCsrf() {
  return CSRF_TOKEN;
}

describe('VistaCampanas', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dibuja las 13 zonas como opciones de un desplegable, con su conteo', async () => {
    mockFetchCampanas();
    render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);

    const select = screen.getByLabelText(/elegir zona/i);
    expect(await within(select).findByRole('option', { name: /GAM Oeste \(28\/30\)/ })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /Guanacaste Interior \(27\/27\)/ })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /^Revisión manual/ })).toBeInTheDocument();
  });

  it('el conteo de la zona elegida queda visible fuera del desplegable, no sólo dentro de él', async () => {
    // Pedido explícito: "conservando el conteo de contactos de cada una a
    // la vista al elegir" -- dentro de un <select> cerrado no se ve nada,
    // así que tiene que repetirse afuera.
    mockFetchCampanas();
    render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);

    expect(await screen.findByText(/28 de 30 contactos de esta zona tienen correo/i)).toBeInTheDocument();
  });

  it('a quien no tiene correo se lo ve pero su casilla está deshabilitada', async () => {
    mockFetchCampanas();
    render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);

    // Contacto 28 (índice 28, el primero sin correo) está en la página 2 --
    // se navega ahí.
    await screen.findByRole('option', { name: /GAM Oeste/ });
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole('button', { name: /siguiente/i }));

    const [filaSinCorreo] = await screen.findAllByText(/sin correo -- no se puede seleccionar/i);
    const fila = filaSinCorreo.closest('tr')!;
    const casilla = within(fila).getByRole('checkbox');
    expect(casilla).toBeDisabled();
    expect(casilla).not.toBeChecked();
  });

  it('selección: "esta página" y "toda la zona" dan cantidades DISTINTAS y visibles', async () => {
    mockFetchCampanas();
    render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    await screen.findByRole('option', { name: /GAM Oeste/ });
    const usuario = userEvent.setup();

    const botonPagina = await screen.findByRole('button', { name: /seleccionar esta página \(20\)/i });
    await usuario.click(botonPagina);
    expect(await screen.findByRole('button', { name: /enviar a 20 destinatarios/i })).toBeInTheDocument();

    const botonZona = screen.getByRole('button', { name: /seleccionar toda la zona \(28\)/i });
    await usuario.click(botonZona);
    expect(await screen.findByRole('button', { name: /enviar a 28 destinatarios/i })).toBeInTheDocument();
    // Y ya no queda el botón de "20" activo -- la cantidad cambió de verdad.
    expect(screen.queryByRole('button', { name: /enviar a 20 destinatarios/i })).not.toBeInTheDocument();
  });

  it('con "toda la zona" seleccionada, las casillas individuales quedan marcadas y deshabilitadas (no se puede recortar en silencio)', async () => {
    mockFetchCampanas();
    render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    await screen.findByRole('option', { name: /GAM Oeste/ });
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole('button', { name: /seleccionar toda la zona/i }));

    const casillas = await screen.findAllByRole('checkbox');
    // Las de contactos con correo en esta página quedan marcadas y
    // deshabilitadas mientras el modo sea 'zona'.
    const conCorreo = casillas.slice(0, 20);
    for (const c of conCorreo) {
      expect(c).toBeChecked();
      expect(c).toBeDisabled();
    }
  });

  it('crear envía seleccion:"pagina" con los contactIds exactos de la página elegida', async () => {
    let cuerpoRecibido: any = null;
    mockFetchCampanas({ onCrear: (c) => (cuerpoRecibido = c) });
    render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    await screen.findByRole('option', { name: /GAM Oeste/ });
    const usuario = userEvent.setup();

    await usuario.click(await screen.findByRole('button', { name: /seleccionar esta página \(20\)/i }));
    await usuario.click(await screen.findByRole('button', { name: /enviar a 20 destinatarios/i }));
    await usuario.type(await screen.findByLabelText(/escribí ENVIAR para confirmar/i), 'ENVIAR');
    await usuario.click(screen.getByRole('button', { name: /^confirmar y enviar$/i }));

    await waitFor(() => expect(cuerpoRecibido).not.toBeNull());
    expect(cuerpoRecibido.seleccion).toBe('pagina');
    expect(cuerpoRecibido.contactIds).toHaveLength(20);
    expect(cuerpoRecibido.zona).toBe('GAM Oeste');
  });

  it('crear envía seleccion:"zona" (sin depender de contactIds) cuando se eligió toda la zona', async () => {
    let cuerpoRecibido: any = null;
    mockFetchCampanas({ onCrear: (c) => (cuerpoRecibido = c) });
    render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    await screen.findByRole('option', { name: /GAM Oeste/ });
    const usuario = userEvent.setup();

    await usuario.click(await screen.findByRole('button', { name: /seleccionar toda la zona/i }));
    await usuario.click(await screen.findByRole('button', { name: /enviar a 28 destinatarios/i }));
    await usuario.type(await screen.findByLabelText(/escribí ENVIAR para confirmar/i), 'ENVIAR');
    await usuario.click(screen.getByRole('button', { name: /^confirmar y enviar$/i }));

    await waitFor(() => expect(cuerpoRecibido).not.toBeNull());
    expect(cuerpoRecibido.seleccion).toBe('zona');
  });

  it('el botón de confirmar queda deshabilitado hasta escribir la palabra exacta', async () => {
    mockFetchCampanas();
    render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    await screen.findByRole('option', { name: /GAM Oeste/ });
    const usuario = userEvent.setup();

    await usuario.click(await screen.findByRole('button', { name: /seleccionar esta página \(20\)/i }));
    await usuario.click(await screen.findByRole('button', { name: /enviar a 20 destinatarios/i }));

    const botonConfirmar = screen.getByRole('button', { name: /^confirmar y enviar$/i });
    expect(botonConfirmar).toBeDisabled();

    const campo = screen.getByLabelText(/escribí ENVIAR para confirmar/i);
    await usuario.type(campo, 'enviar mal');
    expect(botonConfirmar).toBeDisabled();

    await usuario.clear(campo);
    await usuario.type(campo, 'ENVIAR');
    expect(botonConfirmar).not.toBeDisabled();
  });

  it('sin seleccionar a nadie, el botón de enviar queda deshabilitado', async () => {
    mockFetchCampanas();
    render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    await screen.findByRole('option', { name: /GAM Oeste/ });
    expect(screen.getByRole('button', { name: /enviar a 0 destinatarios/i })).toBeDisabled();
  });

  it('manda la campaña por varias tandas y muestra el progreso hasta terminar', async () => {
    mockFetchCampanas({
      enviarSecuencia: [
        { procesados: 20, enviados: 20, fallidos: 0, terminada: false },
        { procesados: 8, enviados: 8, fallidos: 0, terminada: true },
      ],
    });
    render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    await screen.findByRole('option', { name: /GAM Oeste/ });
    const usuario = userEvent.setup();

    await usuario.click(await screen.findByRole('button', { name: /seleccionar toda la zona/i }));
    await usuario.click(await screen.findByRole('button', { name: /enviar a 28 destinatarios/i }));
    await usuario.type(await screen.findByLabelText(/escribí ENVIAR para confirmar/i), 'ENVIAR');
    await usuario.click(screen.getByRole('button', { name: /^confirmar y enviar$/i }));

    await waitFor(() => {
      expect(screen.getByText(/la campaña terminó de enviarse/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/28 enviados/)).toBeInTheDocument();
  });

  // El historial (aviso de campaña interrumpida, retomarla desde ahí,
  // cancelarla) ya no vive en esta pantalla -- se mudó a
  // VistaHistorialCampanas.tsx (encargo del dueño, punto 2). Esas pruebas
  // están en tests/vista-historial-campanas-ui.test.tsx.

  // Pedido expreso del dueño: "cambiar de zona con una selección de
  // destinatarios ya hecha es una forma fácil de mandarle una campaña a la
  // zona equivocada". La salida elegida es descartar la selección al
  // cambiar de zona -- esta prueba lo ancla desde los dos modos posibles
  // ('manual', con "esta página", y 'zona', con "toda la zona"), y desde
  // los dos lugares donde la selección se nota: el botón "Enviar a N
  // destinatarios" y las casillas de la tabla.
  //
  // Verificado por mutación (a mano): comentando la línea
  // `setSeleccion({ modo: 'ninguna' })` dentro de `elegirZona`
  // (VistaCampanas.tsx) las dos aserciones de "enviar a 0 destinatarios"
  // de abajo pasan a fallar (el botón se queda leyendo "20"/"28"
  // destinatarios) -- confirmado y revertido antes de dejar esta prueba en
  // verde.
  it('cambiar de zona descarta la selección anterior (ni "esta página" ni "toda la zona" sobreviven)', async () => {
    mockFetchCampanas();
    render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    const usuario = userEvent.setup();
    const select = screen.getByLabelText(/elegir zona/i);

    // Caso 1: selección manual ("esta página").
    await screen.findByRole('option', { name: /GAM Oeste/ });
    await usuario.click(await screen.findByRole('button', { name: /seleccionar esta página \(20\)/i }));
    expect(await screen.findByRole('button', { name: /enviar a 20 destinatarios/i })).toBeInTheDocument();

    await usuario.selectOptions(select, 'GAM Centro');
    expect(await screen.findByRole('button', { name: /enviar a 0 destinatarios/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enviar a 20 destinatarios/i })).not.toBeInTheDocument();
    // Sin selección, tampoco debe quedar el botón de "Quitar selección".
    expect(screen.queryByRole('button', { name: /quitar selección/i })).not.toBeInTheDocument();

    // Caso 2: selección de "toda la zona" -- el modo que además marca y
    // deshabilita las casillas; si sobreviviera al cambio de zona sería el
    // más peligroso de los dos (manda a TODOS los contactos con correo).
    // (El mock de /api/campanas/contactos, `contactosDeZona`, devuelve la
    // misma forma para cualquier zona -- 28 con correo de 30 -- así que
    // "toda la zona" vuelve a dar 28 en GAM Centro, igual que en GAM Oeste.)
    await usuario.click(await screen.findByRole('button', { name: /seleccionar toda la zona \(28\)/i }));
    expect(await screen.findByRole('button', { name: /enviar a 28 destinatarios/i })).toBeInTheDocument();

    await usuario.selectOptions(select, 'GAM Oeste');
    expect(await screen.findByRole('button', { name: /enviar a 0 destinatarios/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enviar a 28 destinatarios/i })).not.toBeInTheDocument();
    // Y las casillas de la nueva zona no llegan marcadas de arrastre.
    const casillas = await screen.findAllByRole('checkbox');
    for (const c of casillas) expect(c).not.toBeChecked();
  });

  it('un 401 a mitad de trabajo llama a onSesionInvalida', async () => {
    const onSesionInvalida = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'sesión vencida' }), { status: 401 }),
    );
    render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={onSesionInvalida} />);
    await waitFor(() => expect(onSesionInvalida).toHaveBeenCalled());
  });
});

// ---------------------------------------------------------------------
// Punto 4 del encargo: la sección "Plantilla" plegable.
describe('VistaCampanas — sección "Plantilla" plegable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('arranca plegada, con el nombre y el asunto visibles en el resumen sin desplegar', async () => {
    mockFetchCampanas();
    const { container } = render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    await screen.findByRole('option', { name: /GAM Oeste/ });
    // Espera a que carguen las plantillas -- "Asunto inicial" sólo aparece
    // una vez que `plantillaActual` tiene datos.
    await screen.findByText(/asunto inicial/i);

    const detalle = container.querySelector('details');
    expect(detalle).not.toBeNull();
    expect(detalle?.open).toBe(false);
    expect(container.querySelector('summary')?.textContent).toMatch(/correo inicial/i);
    // Nota: no se comprueba acá que el contenido quede OCULTO -- jsdom no
    // aplica la hoja de estilos por defecto del navegador que hace
    // `details:not([open]) > *:not(summary) { display: none }`, así que
    // `getByLabelText`/`queryByLabelText` seguirían encontrando el
    // `<textarea>` en el DOM aunque esté plegado. Lo único que SÍ es
    // observable acá -- y lo que de verdad importa: `detalle.open` es
    // `false` (comprobado arriba), que es la propiedad real que el
    // navegador usa para decidir si mostrar el contenido.
  });

  it('se despliega al hacer click en el resumen, y sigue desplegada al cambiar entre las cuatro plantillas fijas', async () => {
    mockFetchCampanas();
    const { container } = render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    await screen.findByRole('option', { name: /GAM Oeste/ });
    await screen.findByText(/asunto inicial/i);
    const usuario = userEvent.setup();

    await usuario.click(container.querySelector('summary')!);
    expect(container.querySelector('details')?.open).toBe(true);
    expect(await screen.findByLabelText(/párrafo 1/i)).toBeInTheDocument();

    await usuario.click(screen.getByLabelText(/^primer seguimiento$/i));
    expect(container.querySelector('details')?.open).toBe(true);
    expect(await screen.findByLabelText(/párrafo 1/i)).toBeInTheDocument();
  });

  it('cambiar de ZONA no pliega ni despliega la sección de plantilla', async () => {
    mockFetchCampanas();
    const { container } = render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    await screen.findByRole('option', { name: /GAM Oeste/ });
    await screen.findByText(/asunto inicial/i);
    const usuario = userEvent.setup();

    await usuario.click(container.querySelector('summary')!);
    expect(container.querySelector('details')?.open).toBe(true);

    await usuario.selectOptions(screen.getByLabelText(/elegir zona/i), 'GAM Centro');
    expect(container.querySelector('details')?.open).toBe(true);
  });

  it('elegir "HTML personalizado" despliega la sección aunque estuviera plegada', async () => {
    mockFetchCampanas();
    const { container } = render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    await screen.findByRole('option', { name: /GAM Oeste/ });
    await screen.findByText(/asunto inicial/i);
    expect(container.querySelector('details')?.open).toBe(false);

    const usuario = userEvent.setup();
    await usuario.click(screen.getByLabelText(/^html personalizado$/i));

    expect(container.querySelector('details')?.open).toBe(true);
    expect(await screen.findByLabelText(/^asunto$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/html del correo/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------
// Punto 3 del encargo: plantilla personalizada (HTML pegado a mano).
describe('VistaCampanas — plantilla "personalizada"', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function elegirPersonalizadaConSeleccion() {
    render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    await screen.findByRole('option', { name: /GAM Oeste/ });
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole('button', { name: /seleccionar esta página \(20\)/i }));
    await usuario.click(screen.getByLabelText(/^html personalizado$/i));
    return usuario;
  }

  it('el resumen avisa que falta {{unsubscribe_url}} mientras el html no lo trae', async () => {
    mockFetchCampanas();
    const { container } = render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    await screen.findByRole('option', { name: /GAM Oeste/ });
    const usuario = userEvent.setup();
    await usuario.click(screen.getByLabelText(/^html personalizado$/i));

    expect(container.querySelector('summary')?.textContent).toMatch(/falta.*unsubscribe_url/i);

    // `fireEvent.change`, no `usuario.type`: userEvent interpreta `{` como
    // el inicio de una tecla especial (`{enter}`, etc.) -- escribir
    // "{{unsubscribe_url}}" carácter por carácter lo corrompería. Un pegado
    // (o, como acá, un cambio directo del valor) no tiene ese problema.
    fireEvent.change(screen.getByLabelText(/html del correo/i), {
      target: { value: '<a href="{{unsubscribe_url}}">Baja</a>' },
    });
    await waitFor(() => expect(container.querySelector('summary')?.textContent).not.toMatch(/falta.*unsubscribe_url/i));
  });

  it('el botón de enviar queda deshabilitado hasta previsualizar, y se vuelve a deshabilitar si se edita el html después', async () => {
    mockFetchCampanas();
    const usuario = await elegirPersonalizadaConSeleccion();

    await usuario.type(screen.getByLabelText(/^asunto$/i), 'Mi asunto');
    // `fireEvent.change`, no `usuario.type`: userEvent interpreta `{` como
    // el inicio de una tecla especial (`{enter}`, etc.) -- escribir
    // "{{unsubscribe_url}}" carácter por carácter lo corrompería. Un pegado
    // (o, como acá, un cambio directo del valor) no tiene ese problema.
    fireEvent.change(screen.getByLabelText(/html del correo/i), {
      target: { value: '<a href="{{unsubscribe_url}}">Baja</a>' },
    });

    const botonEnviar = await screen.findByRole('button', { name: /enviar a 20 destinatarios/i });
    expect(botonEnviar).toBeDisabled();
    expect(screen.getByText(/primero tenés que previsualizarlo/i)).toBeInTheDocument();

    await usuario.click(screen.getByRole('button', { name: /previsualizar/i }));
    await waitFor(() => expect(botonEnviar).not.toBeDisabled());
    expect(screen.queryByText(/primero tenés que previsualizarlo/i)).not.toBeInTheDocument();

    // Editar el html DESPUÉS de previsualizar vuelve a bloquear el envío --
    // el defecto exacto que pide el encargo ("que sea imposible mandar...
    // sin haberla visto").
    fireEvent.change(screen.getByLabelText(/html del correo/i), {
      target: { value: '<a href="{{unsubscribe_url}}">Baja</a><p>agregado después</p>' },
    });
    expect(botonEnviar).toBeDisabled();
  });

  // El aviso del coordinador: plegar/desplegar el acordeón NUNCA cuenta
  // como "ya la vi" -- sólo un POST /previsualizar exitoso lo hace.
  it('plegar y desplegar la sección NO cuenta como haber previsualizado', async () => {
    mockFetchCampanas();
    const { container } = render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    await screen.findByRole('option', { name: /GAM Oeste/ });
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole('button', { name: /seleccionar esta página \(20\)/i }));
    await usuario.click(screen.getByLabelText(/^html personalizado$/i));
    await usuario.type(screen.getByLabelText(/^asunto$/i), 'Asunto');
    // `fireEvent.change`, no `usuario.type`: userEvent interpreta `{` como
    // el inicio de una tecla especial (`{enter}`, etc.) -- escribir
    // "{{unsubscribe_url}}" carácter por carácter lo corrompería. Un pegado
    // (o, como acá, un cambio directo del valor) no tiene ese problema.
    fireEvent.change(screen.getByLabelText(/html del correo/i), {
      target: { value: '<a href="{{unsubscribe_url}}">Baja</a>' },
    });

    const botonEnviar = await screen.findByRole('button', { name: /enviar a 20 destinatarios/i });
    expect(botonEnviar).toBeDisabled();

    // Plegar y volver a desplegar, sin previsualizar.
    await usuario.click(container.querySelector('summary')!);
    expect(container.querySelector('details')?.open).toBe(false);
    await usuario.click(container.querySelector('summary')!);
    expect(container.querySelector('details')?.open).toBe(true);

    expect(botonEnviar).toBeDisabled();
  });

  it('previsualizar manda plantilla/asunto/previewText/html, no "parrafos"', async () => {
    const fetchImpl = mockFetchCampanas();
    const usuario = await elegirPersonalizadaConSeleccion();
    await usuario.type(screen.getByLabelText(/^asunto$/i), 'Mi asunto');
    // `fireEvent.change`, no `usuario.type`: userEvent interpreta `{` como
    // el inicio de una tecla especial (`{enter}`, etc.) -- escribir
    // "{{unsubscribe_url}}" carácter por carácter lo corrompería. Un pegado
    // (o, como acá, un cambio directo del valor) no tiene ese problema.
    fireEvent.change(screen.getByLabelText(/html del correo/i), {
      target: { value: '<a href="{{unsubscribe_url}}">Baja</a>' },
    });
    await usuario.click(screen.getByRole('button', { name: /previsualizar/i }));

    await waitFor(() => {
      const llamada = fetchImpl.mock.calls.find(([input]) =>
        (typeof input === 'string' ? input : input.toString()).endsWith('/api/campanas/previsualizar'),
      );
      expect(llamada).toBeDefined();
      const cuerpo = JSON.parse((llamada as any)[1].body);
      expect(cuerpo.plantilla).toBe('personalizada');
      expect(cuerpo.asunto).toBe('Mi asunto');
      expect(cuerpo.html).toContain('unsubscribe_url');
      expect(cuerpo.parrafos).toBeUndefined();
    });
  });

  it('crear manda asunto/previewText/html/firmaPrevisualizacion, con la firma de la última previsualización', async () => {
    let cuerpoRecibido: any = null;
    mockFetchCampanas({ onCrear: (c) => (cuerpoRecibido = c) });
    const usuario = await elegirPersonalizadaConSeleccion();
    await usuario.type(screen.getByLabelText(/^asunto$/i), 'Mi asunto');
    // `fireEvent.change`, no `usuario.type`: userEvent interpreta `{` como
    // el inicio de una tecla especial (`{enter}`, etc.) -- escribir
    // "{{unsubscribe_url}}" carácter por carácter lo corrompería. Un pegado
    // (o, como acá, un cambio directo del valor) no tiene ese problema.
    fireEvent.change(screen.getByLabelText(/html del correo/i), {
      target: { value: '<a href="{{unsubscribe_url}}">Baja</a>' },
    });
    await usuario.click(screen.getByRole('button', { name: /previsualizar/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /enviar a 20 destinatarios/i })).not.toBeDisabled(),
    );

    await usuario.click(screen.getByRole('button', { name: /enviar a 20 destinatarios/i }));
    await usuario.type(await screen.findByLabelText(/escribí ENVIAR para confirmar/i), 'ENVIAR');
    await usuario.click(screen.getByRole('button', { name: /^confirmar y enviar$/i }));

    await waitFor(() => expect(cuerpoRecibido).not.toBeNull());
    expect(cuerpoRecibido.plantilla).toBe('personalizada');
    expect(cuerpoRecibido.asunto).toBe('Mi asunto');
    expect(cuerpoRecibido.html).toContain('unsubscribe_url');
    expect(cuerpoRecibido.firmaPrevisualizacion).toBe('firma(Mi asunto|<a href="{{unsubscribe_url}}">Baja</a>)');
    expect(cuerpoRecibido.parrafos).toBeUndefined();
  });

  it('muestra las advertencias de qué se quitó del html en la última previsualización', async () => {
    mockFetchCampanas();
    const usuario = await elegirPersonalizadaConSeleccion();
    await usuario.type(screen.getByLabelText(/^asunto$/i), 'Asunto');
    fireEvent.change(screen.getByLabelText(/html del correo/i), {
      target: { value: '<a href="{{unsubscribe_url}}">Baja</a><script>x</script>' },
    });
    await usuario.click(screen.getByRole('button', { name: /previsualizar/i }));

    expect(await screen.findByText(/se quitó 1 etiqueta <script>/i)).toBeInTheDocument();
  });
});
