import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Cotizador from '@/app/cotizador/Panel';
import { VistaHistorialCampanas } from '@/app/cotizador/VistaHistorialCampanas';

// Encargo del dueño, punto 2: el historial deja de ser una cola al fondo de
// "Campañas" y pasa a tener su propia pestaña. Punto 1: desde acá se puede
// retomar Y cancelar una campaña. Mismo criterio de dos niveles que
// tests/vista-campanas-ui.test.tsx:
//   1. `describe('Panel — pestaña historial de campañas')` monta `Panel`
//      entero para comprobar que la pestaña se dibuja o no según el `rol`.
//   2. `describe('VistaHistorialCampanas')` monta el componente solo.

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

describe('Panel — pestaña historial de campañas', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no muestra la pestaña a un vendedor', async () => {
    mockFetchPanel({ rol: 'vendedor' });
    render(<Cotizador />);
    await waitFor(() => {
      expect(screen.getByText(/sesión de ana solano/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /historial de campañas/i })).not.toBeInTheDocument();
  });

  it('la muestra a un superadmin, aparte del botón "Campañas"', async () => {
    mockFetchPanel({ rol: 'superadmin' });
    render(<Cotizador />);
    expect(await screen.findByRole('button', { name: /^campañas$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /historial de campañas/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------

type FilaCampana = {
  id: string;
  zona: string | null;
  plantilla: string;
  asunto: string;
  creadoPor: string;
  creadoAt: string;
  progreso: { total: number; enviados: number; fallidos: number; pendientes: number };
  canceladaAt: string | null;
  canceladaPor: string | null;
};

function mockFetchHistorial(opciones: {
  campanas?: FilaCampana[];
  onCancelar?: (cuerpo: any) => void;
  enviarSecuencia?: Array<{ procesados: number; enviados: number; fallidos: number; terminada: boolean; cancelada?: boolean }>;
} = {}) {
  let llamadasEnviar = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const cuerpo = init?.body ? JSON.parse(init.body as string) : {};

    if (url.endsWith('/api/campanas/listado')) {
      return new Response(JSON.stringify({ ok: true, campanas: opciones.campanas ?? [] }), { status: 200 });
    }
    if (url.endsWith('/api/campanas/enviar')) {
      const secuencia = opciones.enviarSecuencia ?? [{ procesados: 1, enviados: 1, fallidos: 0, terminada: true }];
      const resultado = secuencia[Math.min(llamadasEnviar, secuencia.length - 1)];
      llamadasEnviar++;
      return new Response(JSON.stringify({ ok: true, ...resultado }), { status: 200 });
    }
    if (url.endsWith('/api/campanas/cancelar')) {
      opciones.onCancelar?.(cuerpo);
      return new Response(JSON.stringify({ ok: true, yaEstabaCancelada: false }), { status: 200 });
    }
    throw new Error(`Fetch no simulado en la prueba: ${url}`);
  });
}

function obtenerCsrf() {
  return CSRF_TOKEN;
}

const CAMPANA_TERMINADA: FilaCampana = {
  id: 'camp-terminada',
  zona: 'GAM Oeste',
  plantilla: 'inicial',
  asunto: 'Asunto',
  creadoPor: 'Ana Solano',
  creadoAt: '2026-01-01T10:00:00Z',
  progreso: { total: 10, enviados: 10, fallidos: 0, pendientes: 0 },
  canceladaAt: null,
  canceladaPor: null,
};

const CAMPANA_INTERRUMPIDA: FilaCampana = {
  id: 'camp-interrumpida',
  zona: 'Guanacaste Costa',
  plantilla: 'seguimiento_1',
  asunto: 'Asunto seguimiento',
  creadoPor: 'Beto',
  creadoAt: '2026-01-02T10:00:00Z',
  progreso: { total: 50, enviados: 30, fallidos: 0, pendientes: 20 },
  canceladaAt: null,
  canceladaPor: null,
};

const CAMPANA_CANCELADA: FilaCampana = {
  id: 'camp-cancelada',
  zona: 'Caribe',
  plantilla: 'inicial',
  asunto: 'Asunto cancelada',
  creadoPor: 'Ana Solano',
  creadoAt: '2026-01-03T10:00:00Z',
  progreso: { total: 40, enviados: 15, fallidos: 0, pendientes: 25 },
  canceladaAt: '2026-01-03T11:00:00Z',
  canceladaPor: 'Ana Solano',
};

describe('VistaHistorialCampanas', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sin campañas, avisa que todavía no se creó ninguna', async () => {
    mockFetchHistorial({ campanas: [] });
    render(<VistaHistorialCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    expect(await screen.findByText(/todavía no se creó ninguna campaña/i)).toBeInTheDocument();
  });

  it('una campaña terminada no ofrece ni Retomar ni Cancelar', async () => {
    mockFetchHistorial({ campanas: [CAMPANA_TERMINADA] });
    render(<VistaHistorialCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    expect(await screen.findByText(/10\/10 enviados/)).toBeInTheDocument();
    expect(screen.getByText(/terminada\./i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retomar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancelar/i })).not.toBeInTheDocument();
  });

  // Hallazgo importante (revisión final, punto 2): sin esto no había forma
  // de saber, mirando el historial, a qué zona se le escribió, ni de leer
  // el asunto (viajaba en la respuesta pero la pantalla nunca lo pintaba).
  it('muestra la zona y el asunto de cada campaña', async () => {
    mockFetchHistorial({ campanas: [CAMPANA_INTERRUMPIDA] });
    render(<VistaHistorialCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    expect(await screen.findByText('Guanacaste Costa')).toBeInTheDocument();
    expect(screen.getByText('Asunto seguimiento')).toBeInTheDocument();
  });

  it('una campaña vieja sin zona (creada antes de tener este dato) muestra "—", no vacío ni un error', async () => {
    mockFetchHistorial({ campanas: [{ ...CAMPANA_TERMINADA, zona: null }] });
    render(<VistaHistorialCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    expect(await screen.findByText('—')).toBeInTheDocument();
  });

  it('una campaña interrumpida ofrece Retomar y Cancelar, con el conteo de pendientes', async () => {
    mockFetchHistorial({ campanas: [CAMPANA_INTERRUMPIDA] });
    render(<VistaHistorialCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    expect(await screen.findByText(/30\/50 enviados/)).toBeInTheDocument();
    expect(screen.getByText(/interrumpida -- quedan 20/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^retomar$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancelar$/i })).toBeInTheDocument();
  });

  it('una campaña cancelada muestra quién y cuándo, sin ofrecer acciones', async () => {
    mockFetchHistorial({ campanas: [CAMPANA_CANCELADA] });
    render(<VistaHistorialCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    expect(await screen.findByText(/cancelada por ana solano/i)).toBeInTheDocument();
    expect(screen.getByText(/25 sin mandar/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^retomar$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^cancelar$/i })).not.toBeInTheDocument();
  });

  it('retomar manda tandas hasta terminar, y muestra el mensaje final', async () => {
    mockFetchHistorial({
      campanas: [CAMPANA_INTERRUMPIDA],
      enviarSecuencia: [
        { procesados: 10, enviados: 10, fallidos: 0, terminada: false },
        { procesados: 10, enviados: 10, fallidos: 0, terminada: true },
      ],
    });
    render(<VistaHistorialCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole('button', { name: /^retomar$/i }));

    await waitFor(() => {
      expect(screen.getByText(/la campaña terminó de enviarse/i)).toBeInTheDocument();
    });
  });

  it('si la campaña se cancela a mitad de un retomar, lo avisa y no sigue', async () => {
    mockFetchHistorial({
      campanas: [CAMPANA_INTERRUMPIDA],
      enviarSecuencia: [{ procesados: 10, enviados: 10, fallidos: 0, terminada: true, cancelada: true }],
    });
    render(<VistaHistorialCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole('button', { name: /^retomar$/i }));

    await waitFor(() => {
      expect(screen.getByText(/se canceló mientras se estaba mandando/i)).toBeInTheDocument();
    });
  });

  it('mientras una fila está retomando, Retomar/Cancelar de las OTRAS filas queda deshabilitado', async () => {
    // Un fetch controlado a mano para /enviar -- se queda "colgado" hasta
    // que la prueba decide resolverlo, para poder comprobar el estado
    // DESHABILITADO sin pelear con lo rápido que resuelve un mock normal
    // (con un mock instantáneo, todo el `for(;;)` de `retomar` -- que acá
    // sería de una sola tanda, `terminada: true` -- ya terminó antes de que
    // cualquier `waitFor` llegue a mirar nada).
    let resolverEnviar: ((v: unknown) => void) | null = null;
    const promesaEnviar = new Promise((resolve) => {
      resolverEnviar = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/campanas/listado')) {
        return new Response(
          JSON.stringify({
            ok: true,
            campanas: [CAMPANA_INTERRUMPIDA, { ...CAMPANA_INTERRUMPIDA, id: 'camp-otra', creadoPor: 'Otra' }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/campanas/enviar')) {
        await promesaEnviar;
        return new Response(JSON.stringify({ ok: true, procesados: 20, enviados: 20, fallidos: 0, terminada: true }), {
          status: 200,
        });
      }
      throw new Error(`Fetch no simulado en la prueba: ${url}`);
    });

    render(<VistaHistorialCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    const usuario = userEvent.setup();
    const botonesRetomar = await screen.findAllByRole('button', { name: /^retomar$/i });
    expect(botonesRetomar).toHaveLength(2);

    await usuario.click(botonesRetomar[0]);

    // La fila que se está mandando ya no ofrece "Retomar" (se ve el
    // progreso en su lugar); la OTRA fila sigue ofreciendo el botón, pero
    // deshabilitado, mientras la primera sigue colgada en el fetch.
    await waitFor(() => {
      const restante = screen.getByRole('button', { name: /^retomar$/i });
      expect(restante).toBeDisabled();
    });

    // Caso 15 (revisión final, punto 5): esta prueba prometía "Retomar/
    // Cancelar de las OTRAS filas queda deshabilitado" y sólo consultaba
    // Retomar -- poner `disabled={false}` en el botón Cancelar sobrevivía
    // acá. La fila "Otra" (la que NO se está retomando) tiene que tener su
    // Cancelar deshabilitado también; la fila que SÍ se está retomando
    // (Beto) sigue con el suyo habilitado -- cancelar la misma campaña que
    // se está mandando sigue permitido, a propósito (ver el comentario
    // grande del encabezado del componente).
    const filaOtra = screen.getByText('Otra').closest('tr');
    expect(filaOtra).not.toBeNull();
    expect(within(filaOtra as HTMLElement).getByRole('button', { name: /^cancelar$/i })).toBeDisabled();

    const filaBeto = screen.getByText('Beto').closest('tr');
    expect(filaBeto).not.toBeNull();
    expect(within(filaBeto as HTMLElement).getByRole('button', { name: /^cancelar$/i })).toBeEnabled();

    resolverEnviar!(undefined);
    await waitFor(() => expect(screen.getByText(/la campaña terminó de enviarse/i)).toBeInTheDocument());
  });

  it('cancelar pide confirmación con el progreso actual, y "Volver" no cancela nada', async () => {
    const onCancelar = vi.fn();
    mockFetchHistorial({ campanas: [CAMPANA_INTERRUMPIDA], onCancelar });
    render(<VistaHistorialCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole('button', { name: /^cancelar$/i }));

    const dialogo = await screen.findByRole('dialog');
    expect(within(dialogo).getByText(/30/)).toBeInTheDocument();
    expect(within(dialogo).getByText(/20/)).toBeInTheDocument();

    await usuario.click(within(dialogo).getByRole('button', { name: /volver/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onCancelar).not.toHaveBeenCalled();
  });

  it('confirmar cancelar llama a POST /api/campanas/cancelar con el campanaId, y refresca el listado', async () => {
    const onCancelar = vi.fn();
    const fetchImpl = mockFetchHistorial({ campanas: [CAMPANA_INTERRUMPIDA], onCancelar });
    render(<VistaHistorialCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={() => {}} />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole('button', { name: /^cancelar$/i }));
    const dialogo = await screen.findByRole('dialog');
    await usuario.click(within(dialogo).getByRole('button', { name: /sí, cancelar/i }));

    await waitFor(() => expect(onCancelar).toHaveBeenCalledWith({ campanaId: 'camp-interrumpida' }));
    expect(await screen.findByText(/la campaña se canceló/i)).toBeInTheDocument();
    const llamadasListado = fetchImpl.mock.calls.filter(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/campanas/listado'),
    );
    // Una al montar, otra después de cancelar.
    expect(llamadasListado.length).toBeGreaterThanOrEqual(2);
  });

  it('un 401 al listar llama a onSesionInvalida', async () => {
    const onSesionInvalida = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'sesión vencida' }), { status: 401 }),
    );
    render(<VistaHistorialCampanas obtenerCsrf={obtenerCsrf} onSesionInvalida={onSesionInvalida} />);
    await waitFor(() => expect(onSesionInvalida).toHaveBeenCalled());
  });
});
