import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
      return new Response(
        JSON.stringify({ ok: true, asunto: 'Asunto inicial', previewText: 'preview', html: '<p>hola</p>' }),
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

  it('dibuja las 13 pestañas de zona con su conteo', async () => {
    mockFetchCampanas();
    render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);

    expect(await screen.findByRole('tab', { name: /GAM Oeste \(28\/30\)/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Guanacaste Interior \(27\/27\)/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Revisión manual/ })).toBeInTheDocument();
  });

  it('a quien no tiene correo se lo ve pero su casilla está deshabilitada', async () => {
    mockFetchCampanas();
    render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);

    // Contacto 28 (índice 28, el primero sin correo) está en la página 2 --
    // se navega ahí.
    await screen.findByRole('tab', { name: /GAM Oeste/ });
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
    await screen.findByRole('tab', { name: /GAM Oeste/ });
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
    await screen.findByRole('tab', { name: /GAM Oeste/ });
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
    await screen.findByRole('tab', { name: /GAM Oeste/ });
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
    await screen.findByRole('tab', { name: /GAM Oeste/ });
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
    await screen.findByRole('tab', { name: /GAM Oeste/ });
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
    await screen.findByRole('tab', { name: /GAM Oeste/ });
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
    await screen.findByRole('tab', { name: /GAM Oeste/ });
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

  it('muestra el aviso de campaña interrumpida y permite retomarla', async () => {
    mockFetchCampanas({
      listado: [
        {
          id: 'camp-vieja',
          plantilla: 'inicial',
          asunto: 'Asunto',
          creadoPor: 'Ana Solano',
          creadoAt: '2026-01-01T00:00:00Z',
          progreso: { total: 50, enviados: 30, fallidos: 0, pendientes: 20 },
        },
      ],
      enviarSecuencia: [{ procesados: 20, enviados: 20, fallidos: 0, terminada: true }],
    });
    render(<VistaCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);

    expect(await screen.findByText(/hay una campaña sin terminar/i)).toBeInTheDocument();
    expect(screen.getByText(/30 de 50 enviados/)).toBeInTheDocument();

    const usuario = userEvent.setup();
    await usuario.click(screen.getByRole('button', { name: /retomar el envío/i }));

    await waitFor(() => {
      expect(screen.getByText(/la campaña terminó de enviarse/i)).toBeInTheDocument();
    });
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
