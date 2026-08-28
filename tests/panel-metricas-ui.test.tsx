import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VistaMetricas } from '@/app/cotizador/VistaMetricas';

// Tarea 11: la pestaña "Métricas" del panel. Mismo patrón que
// tests/panel-listado-ui.test.tsx -- `fetch` simulado, sin red -- acotado a
// este componente solo (no pasa por `Panel`): `onVerFallidas` y
// `onSesionInvalida` son props, y esta prueba afirma que se llaman en el
// momento correcto, en vez de renderizar `VistaListado` entera para
// comprobarlo.

const METRICAS = {
  sinRespuesta: { cantidad: 4, monto: 2450000, porVencer: 2, vencidas: 1 },
  ganado: { cantidad: 3, monto: 3600000, diasPromedio: 4 },
  perdido: { cantidad: 1, monto: 500000, diasPromedio: 9 },
  descuento: { monto: 360000, promedioPct: 10 },
  productos: [
    { nombre: 'Set 600 king', unidades: 32, monto: 2592000 },
    { nombre: 'Filipina', unidades: 20, monto: 200000 },
  ],
  porLinea: { uniformes: { monto: 200000 }, hogar: { monto: 2592000 } },
  porOrigen: { humano: 5, agente: 2 },
  fallidas: 3,
};

function mockFetch(opciones: { status?: number; cuerpo?: unknown } = {}) {
  const llamadas: { url: string; init?: RequestInit }[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    llamadas.push({ url, init });
    const status = opciones.status ?? 200;
    const cuerpo = opciones.cuerpo ?? (status === 200 ? { ok: true, metricas: METRICAS } : { ok: false, error: 'Error.' });
    return new Response(JSON.stringify(cuerpo), { status });
  });
  return { spy, llamadas };
}

function renderVista() {
  const onSesionInvalida = vi.fn();
  const onVerFallidas = vi.fn();
  render(<VistaMetricas clave="correcta" onSesionInvalida={onSesionInvalida} onVerFallidas={onVerFallidas} />);
  return { onSesionInvalida, onVerFallidas };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VistaMetricas', () => {
  it('pide las métricas al montar, sin token anti-CSRF (ruta de lectura)', async () => {
    const { llamadas } = mockFetch();
    renderVista();

    await waitFor(() => {
      const llamada = llamadas.find((l) => l.url.endsWith('/api/cotizacion/metricas'));
      expect(llamada).toBeDefined();
      const cabeceras = new Headers(llamada!.init!.headers);
      expect(cabeceras.get('x-csrf-token')).toBeNull();
    });
  });

  it('muestra el monto sin respuesta y cuántas vencen esta semana', async () => {
    mockFetch();
    renderVista();

    await waitFor(() => {
      expect(screen.getByText('₡2.450.000')).toBeInTheDocument();
    });
    expect(screen.getByText(/2 vencen esta semana/i)).toBeInTheDocument();
  });

  it('muestra ganado y perdido del mes, con los días promedio', async () => {
    mockFetch();
    renderVista();

    await waitFor(() => {
      expect(screen.getByText('₡3.600.000')).toBeInTheDocument();
    });
    expect(screen.getByText(/ganado.*3 cotizaciones.*4 día/i)).toBeInTheDocument();
    expect(screen.getByText('₡500.000')).toBeInTheDocument();
    expect(screen.getByText(/perdido.*1 cotizaciones.*9 día/i)).toBeInTheDocument();
  });

  it('muestra el descuento otorgado y su promedio', async () => {
    mockFetch();
    renderVista();

    await waitFor(() => {
      expect(screen.getByText('₡360.000')).toBeInTheDocument();
    });
    expect(screen.getByText(/promedio 10%/i)).toBeInTheDocument();
  });

  it('lista los productos más cotizados', async () => {
    mockFetch();
    renderVista();

    await waitFor(() => {
      expect(screen.getByText('Set 600 king')).toBeInTheDocument();
    });
    expect(screen.getByText('Filipina')).toBeInTheDocument();
    expect(screen.getByText('32 u.')).toBeInTheDocument();
  });

  it('muestra el reparto entre uniformes y hogar', async () => {
    mockFetch();
    renderVista();

    await waitFor(() => {
      expect(screen.getByText(/uniformes/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/₡200\.000 \(7%\)/)).toBeInTheDocument();
    expect(screen.getByText(/₡2\.592\.000 \(93%\)/)).toBeInTheDocument();
  });

  it('muestra las fallidas y lleva al listado filtrado por error', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    const { onVerFallidas } = renderVista();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /fallidas/i })).toBeInTheDocument();
    });
    const bloqueFallidas = screen.getByRole('heading', { name: /fallidas/i }).closest('section') as HTMLElement;
    expect(within(bloqueFallidas).getByText('3')).toBeInTheDocument();

    await usuario.click(within(bloqueFallidas).getByRole('button', { name: /ver en el listado/i }));
    expect(onVerFallidas).toHaveBeenCalledTimes(1);
  });

  it('muestra cuántas nacieron del agente', async () => {
    mockFetch();
    renderVista();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^origen$/i })).toBeInTheDocument();
    });
    const bloqueOrigen = screen.getByRole('heading', { name: /^origen$/i }).closest('section') as HTMLElement;
    expect(within(bloqueOrigen).getByText('2')).toBeInTheDocument();
    expect(within(bloqueOrigen).getByText(/contra 5 que armó un vendedor a mano/i)).toBeInTheDocument();
  });

  // Regla de seguridad: un 401 devuelve al vendedor a la pantalla de clave
  // sin perder lo que armó -- `Panel` ya tiene ese mecanismo
  // (`onSesionInvalida`); esta pantalla lo usa, no inventa uno nuevo.
  it('un 401 llama a onSesionInvalida', async () => {
    mockFetch({ status: 401, cuerpo: { ok: false, error: 'Clave incorrecta.' } });
    const { onSesionInvalida } = renderVista();

    await waitFor(() => {
      expect(onSesionInvalida).toHaveBeenCalledTimes(1);
    });
  });

  it('sin fallar, no muestra ningún bloque a medio pintar', async () => {
    mockFetch({ status: 500, cuerpo: { ok: false, error: 'No se pudo consultar.' } });
    renderVista();

    await waitFor(() => {
      expect(screen.getByText(/no se pudo consultar/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: /fallidas/i })).not.toBeInTheDocument();
  });
});
