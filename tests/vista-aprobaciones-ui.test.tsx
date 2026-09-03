import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Cotizador from '@/app/cotizador/Panel';
import { VistaAprobaciones } from '@/app/cotizador/VistaAprobaciones';

// Fase 5 (descuento con aprobación): la pestaña "Aprobaciones". Mismo
// criterio de dos niveles que tests/equipo-ui.test.tsx:
//
// 1. `describe('Panel — pestaña aprobaciones')` monta `Panel` entero con una
//    sesión ya activa para comprobar que el botón se dibuja o no según el
//    `rol`. El montaje de las dos pruebas de visibilidad es IDÉNTICO salvo
//    por `rol` -- si cambiara algo más, un rechazo por ese otro motivo
//    podría maquillar de "no se ve" un fallo que en realidad es "el fetch
//    nunca llegó a devolver nada".
// 2. `describe('VistaAprobaciones')` monta el componente solo.

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

describe('Panel — pestaña aprobaciones', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no muestra la pestaña de aprobaciones a un vendedor', async () => {
    mockFetchPanel({ rol: 'vendedor' });
    render(<Cotizador />);

    await waitFor(() => {
      expect(screen.getByText(/sesión de ana solano/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^aprobaciones$/i })).not.toBeInTheDocument();
  });

  it('la muestra a un superadmin', async () => {
    mockFetchPanel({ rol: 'superadmin' });
    render(<Cotizador />);

    expect(await screen.findByRole('button', { name: /^aprobaciones$/i })).toBeInTheDocument();
  });

  it('un superadmin puede entrar a la pestaña y ver la vista de aprobaciones', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/cotizacion/catalogo')) {
        return new Response(
          JSON.stringify({ ok: true, skus: [], csrf: CSRF_TOKEN, vendedor: 'Ana Solano', rol: 'superadmin' }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/cotizacion/borradores')) {
        return new Response(JSON.stringify({ ok: true, borradores: [] }), { status: 200 });
      }
      if (url.endsWith('/api/cotizacion/pendientes')) {
        return new Response(JSON.stringify({ ok: true, cotizaciones: [] }), { status: 200 });
      }
      throw new Error(`Fetch no simulado en la prueba: ${url}`);
    });

    const usuario = userEvent.setup();
    render(<Cotizador />);
    const boton = await screen.findByRole('button', { name: /^aprobaciones$/i });
    await usuario.click(boton);

    expect(await screen.findByText(/no hay ninguna solicitud esperando/i)).toBeInTheDocument();
  });
});

const AHORA = new Date('2026-08-26T12:00:00.000Z');

const FILA_GENERAL = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  numero: 'COT-2026-0001',
  created_at: '2026-08-25T12:00:00.000Z', // 1 día antes de AHORA
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
  totales: { total: 500000 },
  descuento_personalizado: { general: 20 },
  solicitado_por: 'Guillermo Rojas',
};

const FILA_FAMILIAS = {
  id: 'a1b2c3d4-0000-4000-8000-000000000002',
  numero: 'COT-2026-0002',
  created_at: '2026-08-26T09:00:00.000Z', // 3 horas antes de AHORA
  cliente: { nombre: 'Beto Ruiz', empresa: 'Hotel Beto', email: 'beto@hotel.com' },
  totales: { total: 300000 },
  descuento_personalizado: { familias: { toallas: 10, bata: 5 } },
  solicitado_por: 'Marta Vargas',
};

type OpcionesFetch = {
  pendientes?: unknown[];
  aprobarRespuesta?: unknown;
  rechazarRespuesta?: unknown;
};

function mockFetch(opciones: OpcionesFetch = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/cotizacion/pendientes')) {
      return new Response(
        JSON.stringify({ ok: true, cotizaciones: opciones.pendientes ?? [FILA_GENERAL] }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/cotizacion/aprobar')) {
      void init;
      return new Response(
        JSON.stringify(
          opciones.aprobarRespuesta ?? { ok: true, numero: FILA_GENERAL.numero, estado: 'enviada', cambioPorcentaje: false, avisoEnviado: true },
        ),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/cotizacion/rechazar')) {
      return new Response(
        JSON.stringify(opciones.rechazarRespuesta ?? { ok: true, numero: FILA_GENERAL.numero, avisoEnviado: true }),
        { status: 200 },
      );
    }
    throw new Error(`Fetch no simulado en la prueba: ${url}`);
  });
}

function renderVista() {
  const onSesionInvalida = vi.fn();
  render(<VistaAprobaciones obtenerCsrf={() => CSRF_TOKEN} onSesionInvalida={onSesionInvalida} />);
  return { onSesionInvalida };
}

describe('VistaAprobaciones', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('lista cada pendiente con cliente, monto, descuento pedido, quién lo pidió y cuánto lleva esperando', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AHORA);
    mockFetch({ pendientes: [FILA_GENERAL, FILA_FAMILIAS] });
    renderVista();
    vi.useRealTimers();

    expect(await screen.findByText(/ana pérez/i)).toBeInTheDocument();
    expect(screen.getByText('₡500.000')).toBeInTheDocument();
    expect(screen.getByText(/descuento pedido: 20% general/i)).toBeInTheDocument();
    expect(screen.getByText(/guillermo rojas/i)).toBeInTheDocument();
    // Por familia: las dos etiquetas legibles, no las claves internas.
    expect(screen.getByText(/descuento pedido: toallas 10%, batas 5%/i)).toBeInTheDocument();
  });

  it('aprobar tal cual manda /aprobar sin descuentoPersonalizado', async () => {
    const fetchEspiado = mockFetch({ pendientes: [FILA_GENERAL] });
    const usuario = userEvent.setup();
    renderVista();

    await usuario.click(await screen.findByRole('button', { name: /aprobar tal cual/i }));

    await waitFor(() => {
      const llamada = fetchEspiado.mock.calls.find(([entrada]) =>
        (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/cotizacion/aprobar'),
      );
      expect(llamada).toBeDefined();
    });
    const llamada = fetchEspiado.mock.calls.find(([entrada]) =>
      (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/cotizacion/aprobar'),
    )!;
    const cuerpo = JSON.parse((llamada[1] as RequestInit).body as string);
    expect(cuerpo).toEqual({ id: FILA_GENERAL.id });
    // La fila resuelta desaparece de la cola.
    await waitFor(() => {
      expect(screen.queryByText(/ana pérez/i)).not.toBeInTheDocument();
    });
  });

  // El requisito central del diseño: "que aprobar con un porcentaje
  // distinto del pedido sea evidente, no un descuido".
  it('cambiar el % muestra un aviso explícito y el botón de confirmar repite los dos números', async () => {
    mockFetch({ pendientes: [FILA_GENERAL] });
    const usuario = userEvent.setup();
    renderVista();

    await usuario.click(await screen.findByRole('button', { name: /cambiar % y aprobar/i }));
    const campo = screen.getByLabelText(/nuevo porcentaje general/i);
    expect(campo).toHaveValue(20); // prellenado con lo pedido

    await usuario.clear(campo);
    await usuario.type(campo, '12');

    expect(screen.getByRole('alert')).toHaveTextContent(/vas a aprobar 12% general en vez de lo pedido \(20% general\)/i);
    expect(screen.getByRole('button', { name: /aprobar con 12% general \(pedido: 20% general\)/i })).toBeInTheDocument();
  });

  // Si no lo toca (o lo deja igual), no hay "cambio" que destacar: ni el
  // aviso aparece, ni el botón dice lo contrario de la verdad.
  it('si no cambia el valor prellenado, no muestra el aviso de cambio', async () => {
    mockFetch({ pendientes: [FILA_GENERAL] });
    const usuario = userEvent.setup();
    renderVista();

    await usuario.click(await screen.findByRole('button', { name: /cambiar % y aprobar/i }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /aprobar \(sin cambios\)/i })).toBeInTheDocument();
  });

  it('confirmar el cambio manda /aprobar con el nuevo descuentoPersonalizado', async () => {
    const fetchEspiado = mockFetch({
      pendientes: [FILA_GENERAL],
      aprobarRespuesta: { ok: true, numero: FILA_GENERAL.numero, estado: 'enviada', cambioPorcentaje: true, avisoEnviado: true },
    });
    const usuario = userEvent.setup();
    renderVista();

    await usuario.click(await screen.findByRole('button', { name: /cambiar % y aprobar/i }));
    const campo = screen.getByLabelText(/nuevo porcentaje general/i);
    await usuario.clear(campo);
    await usuario.type(campo, '12');
    await usuario.click(screen.getByRole('button', { name: /aprobar con 12%/i }));

    await waitFor(() => {
      const llamada = fetchEspiado.mock.calls.find(([entrada]) =>
        (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/cotizacion/aprobar'),
      );
      expect(llamada).toBeDefined();
    });
    const llamada = fetchEspiado.mock.calls.find(([entrada]) =>
      (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/cotizacion/aprobar'),
    )!;
    const cuerpo = JSON.parse((llamada[1] as RequestInit).body as string);
    expect(cuerpo).toEqual({ id: FILA_GENERAL.id, descuentoPersonalizado: { general: 12 } });
    expect(await screen.findByText(/aprobada COT-2026-0001 con el porcentaje cambiado/i)).toBeInTheDocument();
  });

  it('rechazar exige un motivo y lo manda a /rechazar', async () => {
    const fetchEspiado = mockFetch({ pendientes: [FILA_GENERAL] });
    const usuario = userEvent.setup();
    renderVista();

    await usuario.click(await screen.findByRole('button', { name: /^rechazar$/i }));
    const confirmar = screen.getByRole('button', { name: /confirmar rechazo/i });
    expect(confirmar).toBeDisabled();

    await usuario.type(screen.getByLabelText(/motivo del rechazo/i), 'Margen insuficiente');
    expect(confirmar).toBeEnabled();
    await usuario.click(confirmar);

    await waitFor(() => {
      const llamada = fetchEspiado.mock.calls.find(([entrada]) =>
        (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/cotizacion/rechazar'),
      );
      expect(llamada).toBeDefined();
    });
    const llamada = fetchEspiado.mock.calls.find(([entrada]) =>
      (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/cotizacion/rechazar'),
    )!;
    const cuerpo = JSON.parse((llamada[1] as RequestInit).body as string);
    expect(cuerpo).toEqual({ id: FILA_GENERAL.id, motivo: 'Margen insuficiente' });
  });

  it('manda el token anti-CSRF al aprobar', async () => {
    const fetchEspiado = mockFetch({ pendientes: [FILA_GENERAL] });
    const usuario = userEvent.setup();
    renderVista();

    await usuario.click(await screen.findByRole('button', { name: /aprobar tal cual/i }));

    await waitFor(() => {
      const llamada = fetchEspiado.mock.calls.find(([entrada]) =>
        (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/cotizacion/aprobar'),
      );
      expect(llamada).toBeDefined();
    });
    const llamada = fetchEspiado.mock.calls.find(([entrada]) =>
      (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/cotizacion/aprobar'),
    )!;
    expect((llamada[1] as RequestInit & { headers: Record<string, string> }).headers['x-csrf-token']).toBe(
      CSRF_TOKEN,
    );
  });

  it('un 401 avisa que la sesión venció', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'No tenés permiso para aprobar descuentos.' }), { status: 401 }),
    );
    const { onSesionInvalida } = renderVista();

    await waitFor(() => {
      expect(onSesionInvalida).toHaveBeenCalled();
    });
  });
});
