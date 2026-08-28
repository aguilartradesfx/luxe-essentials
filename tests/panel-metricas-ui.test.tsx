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
//
// Ronda de correcciones 1 (hallazgo crítico del revisor): las aserciones de
// "ganado y perdido" hacían `getByText(monto)` y `getByText(etiqueta)` como
// dos búsquedas SUELTAS en toda la pantalla, sin `within` que las atara al
// mismo bloque. Un mutante que intercambia los montos de "Ganado" y
// "Perdido" (dejando las etiquetas donde estaban) seguía en verde: los dos
// textos existían en algún lado de la pantalla, solo que no juntos. Cada
// aserción de monto de acá en adelante busca DENTRO del contenedor de su
// propia etiqueta -- el mismo patrón que ya usaban "Fallidas" y "Origen".

const GANADO_MES_ACTUAL = { cantidad: 3, monto: 3600000, diasPromedio: 4 };
const GANADO_MES_ANTERIOR = { cantidad: 2, monto: 2000000, diasPromedio: 6 };
const PERDIDO_MES_ACTUAL = { cantidad: 1, monto: 500000, diasPromedio: 9 };
const PERDIDO_MES_ANTERIOR = { cantidad: 1, monto: 800000, diasPromedio: 3 };

const METRICAS = {
  sinRespuesta: { cantidad: 4, monto: 2450000, porVencer: 2, vencidas: 1 },
  ganado: { mesActual: GANADO_MES_ACTUAL, mesAnterior: GANADO_MES_ANTERIOR },
  perdido: { mesActual: PERDIDO_MES_ACTUAL, mesAnterior: PERDIDO_MES_ANTERIOR },
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

  // El caso más común en la vida real es UNA sola cotización por vencer, no
  // dos -- y "1 vencen" lee mal. Cubre la concordancia de número por
  // separado del resto, para que un texto plural "a secas" no la esconda.
  it('usa singular cuando solo una cotización vence esta semana o ya venció', async () => {
    mockFetch({
      cuerpo: { ok: true, metricas: { ...METRICAS, sinRespuesta: { cantidad: 1, monto: 100000, porVencer: 1, vencidas: 1 } } },
    });
    renderVista();

    await waitFor(() => {
      expect(screen.getByText(/1 vence esta semana/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/1 vencen esta semana/i)).not.toBeInTheDocument();
    expect(screen.getByText(/1 ya venció/i)).toBeInTheDocument();
    expect(screen.queryByText(/1 ya vencieron/i)).not.toBeInTheDocument();
  });

  it('muestra ganado y perdido del mes, con los días promedio', async () => {
    mockFetch();
    renderVista();

    await waitFor(() => {
      expect(screen.getByText(/ganado este mes/i)).toBeInTheDocument();
    });

    const bloqueGanado = screen.getByText(/ganado este mes/i).closest('div') as HTMLElement;
    expect(within(bloqueGanado).getByText('₡3.600.000')).toBeInTheDocument();
    expect(within(bloqueGanado).getByText(/3 cotizaciones/)).toBeInTheDocument();
    expect(within(bloqueGanado).getByText(/4 día/)).toBeInTheDocument();

    const bloquePerdido = screen.getByText(/perdido este mes/i).closest('div') as HTMLElement;
    expect(within(bloquePerdido).getByText('₡500.000')).toBeInTheDocument();
    expect(within(bloquePerdido).getByText(/1 cotizaciones/)).toBeInTheDocument();
    expect(within(bloquePerdido).getByText(/9 día/)).toBeInTheDocument();

    // Los montos no se cruzan: el de "Ganado" no aparece dentro del bloque
    // de "Perdido" ni viceversa. Esta es la aserción que el mutante de
    // montos intercambiados no puede pasar.
    expect(within(bloqueGanado).queryByText('₡500.000')).not.toBeInTheDocument();
    expect(within(bloquePerdido).queryByText('₡3.600.000')).not.toBeInTheDocument();
  });

  it('muestra el mes anterior y la diferencia, para que el número tenga con qué compararse', async () => {
    mockFetch();
    renderVista();

    await waitFor(() => {
      expect(screen.getByText(/ganado este mes/i)).toBeInTheDocument();
    });

    const bloqueGanado = screen.getByText(/ganado este mes/i).closest('div') as HTMLElement;
    // Mes pasado ₡2.000.000, este mes ₡3.600.000: +₡1.600.000.
    expect(within(bloqueGanado).getByText(/₡2\.000\.000/)).toBeInTheDocument();
    expect(within(bloqueGanado).getByText(/\+₡1\.600\.000/)).toBeInTheDocument();

    const bloquePerdido = screen.getByText(/perdido este mes/i).closest('div') as HTMLElement;
    // Mes pasado ₡800.000, este mes ₡500.000: -₡300.000.
    expect(within(bloquePerdido).getByText(/₡800\.000/)).toBeInTheDocument();
    expect(within(bloquePerdido).getByText(/-₡300\.000/)).toBeInTheDocument();
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

  // El texto anterior decía "Cotizaciones enviadas que todavía no tienen
  // respuesta", pero el cálculo agrupa también las que están en 'creada'
  // -- a las que nunca se les mandó nada. El texto no puede decir "enviadas"
  // sobre algo que puede no haberse enviado.
  it('el texto de "sin respuesta" no afirma que se hayan enviado', async () => {
    mockFetch();
    renderVista();

    await waitFor(() => {
      expect(screen.getByText(/cotizaciones sin respuesta todavía/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/enviadas/i)).not.toBeInTheDocument();
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
