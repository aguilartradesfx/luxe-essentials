import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VistaListado } from '@/app/cotizador/VistaListado';

// Fase 5 (descuento con aprobación): los dos estados nuevos en el listado
// general -- 'esperando_aprobacion' y 'rechazada' -- y "cancelar", la única
// acción que el diseño le permite al vendedor mientras espera. Mismo patrón
// de prueba que tests/panel-listado-ui.test.tsx, acotado a este recorte.

const CSRF_TOKEN = 'csrf-de-prueba';
const LOCATION_ID = 'ubicacion-ghl-1';

const FILA_ESPERANDO = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  numero: 'COT-2026-0020',
  created_at: '2026-08-25T12:00:00.000Z',
  updated_at: '2026-08-25T12:00:00.000Z',
  estado: 'esperando_aprobacion',
  origen: 'humano',
  contact_id: null,
  cliente: { nombre: 'Ana Pérez', empresa: 'Hotel Papagayo', email: 'ana@hotel.com' },
  totales: { subtotal: 500000, ahorro: 0, iva: 65000, total: 565000 },
  enviado_at: null,
  cerrada_at: null,
  pdf_ruta: null,
  motivo_cierre: null,
  ghl_estimate_id: null,
  ghl_error: null,
  correo_error: null,
  vendedor: 'Guillermo Rojas',
  reemplaza_a_numero: null,
  reemplazada_por_numero: null,
  descuento_personalizado: { general: 20 },
  solicitado_por: 'Guillermo Rojas',
  aprobado_por: null,
  resuelto_at: null,
  motivo_rechazo: null,
  descuento_aprobado: null,
};

const FILA_RECHAZADA = {
  ...FILA_ESPERANDO,
  id: 'a1b2c3d4-0000-4000-8000-000000000002',
  numero: 'COT-2026-0021',
  estado: 'rechazada',
  cliente: { nombre: 'Beto Ruiz', empresa: 'Hotel Beto', email: 'beto@hotel.com' },
  aprobado_por: 'Ana Solano',
  resuelto_at: '2026-08-25T15:00:00.000Z',
  motivo_rechazo: 'Margen insuficiente',
};

type OpcionesFetch = {
  filas?: unknown[];
  cancelarStatus?: number;
  cancelarRespuesta?: unknown;
};

function mockFetch(opciones: OpcionesFetch = {}) {
  const llamadas: { url: string; init?: RequestInit }[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    llamadas.push({ url, init });

    if (url.endsWith('/api/cotizacion/listado')) {
      return new Response(
        JSON.stringify({ ok: true, cotizaciones: opciones.filas ?? [FILA_ESPERANDO], locationId: LOCATION_ID }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/cotizacion/cancelar')) {
      const status = opciones.cancelarStatus ?? 200;
      return new Response(JSON.stringify(opciones.cancelarRespuesta ?? { ok: true }), { status });
    }
    throw new Error(`Fetch no simulado en la prueba: ${url}`);
  });
  return { spy, llamadas };
}

function renderVista() {
  const onSesionInvalida = vi.fn();
  const onDuplicar = vi.fn();
  render(<VistaListado obtenerCsrf={() => CSRF_TOKEN} onSesionInvalida={onSesionInvalida} onDuplicar={onDuplicar} />);
  return { onSesionInvalida, onDuplicar };
}

async function abrirMenu(usuario: ReturnType<typeof userEvent.setup>, fila: HTMLElement) {
  await usuario.click(within(fila).getByRole('button', { name: /más acciones/i }));
  return within(document.body).getByRole('menu');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VistaListado — descuento con aprobación (fase 5)', () => {
  it('muestra la píldora "Esperando aprobación", con el descuento pedido y quién lo pidió', async () => {
    mockFetch({ filas: [FILA_ESPERANDO] });
    renderVista();

    expect(await screen.findByText(/esperando aprobación/i)).toBeInTheDocument();
    expect(screen.getByText(/pedido: 20% general \(por guillermo rojas\)/i)).toBeInTheDocument();
  });

  it('muestra la píldora "Rechazada", con el motivo y quién la rechazó', async () => {
    mockFetch({ filas: [FILA_RECHAZADA] });
    renderVista();

    expect(await screen.findByText(/^rechazada$/i)).toBeInTheDocument();
    expect(screen.getByText(/margen insuficiente/i)).toBeInTheDocument();
    expect(screen.getByText(/rechazada por ana solano/i)).toBeInTheDocument();
  });

  // Lo que el diseño prohíbe ofrecer sobre una fila que nunca salió al
  // hotel: nada que dependa de que ya salió (Reenviar, ya cubierto por
  // `pdf_ruta`), nada que suponga un precio en pie (Modificar), y nada de
  // cerrar un trato que nunca llegó a existir (Ganada/Perdida).
  //
  // Hallazgo del dueño (ronda de correcciones): "Ganada"/"Perdida" ya no
  // son botones sueltos en la fila -- viven dentro de este mismo menú, ver
  // VistaListado.tsx. La prueba se adapta para seguir buscándolas donde
  // ahora viven (`menuitem`, no `button`) -- si se buscara por `button`
  // seguiría en verde aunque el menú SÍ las mostrara, porque nunca hay un
  // `button` con ese nombre ahí adentro (son `role="menuitem"`).
  it('una fila "esperando_aprobacion" no ofrece Ganada, Perdida, Reenviar ni Modificar', async () => {
    mockFetch({ filas: [FILA_ESPERANDO] });
    renderVista();

    const fila = (await screen.findByText('Ana Pérez')).closest('tr') as HTMLElement;
    const menu = await abrirMenu(userEvent.setup(), fila);
    expect(within(menu).queryByRole('menuitem', { name: /marcar como ganada/i })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /marcar como perdida/i })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /reenviar/i })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /modificar/i })).not.toBeInTheDocument();
  });

  // La única acción que el diseño permite mientras espera.
  it('una fila "esperando_aprobacion" SÍ ofrece "Cancelar solicitud" en el menú', async () => {
    mockFetch({ filas: [FILA_ESPERANDO] });
    const usuario = userEvent.setup();
    renderVista();

    const fila = (await screen.findByText('Ana Pérez')).closest('tr') as HTMLElement;
    const menu = await abrirMenu(usuario, fila);
    expect(within(menu).getByRole('menuitem', { name: /cancelar solicitud/i })).toBeInTheDocument();
  });

  // Una fila ya resuelta (rechazada) no tiene ninguna solicitud que
  // cancelar -- ni Ganada/Perdida, que tampoco aplican sobre algo que nunca
  // salió al hotel.
  it('una fila "rechazada" no ofrece "Cancelar solicitud" ni Ganada/Perdida', async () => {
    mockFetch({ filas: [FILA_RECHAZADA] });
    const usuario = userEvent.setup();
    renderVista();

    const fila = (await screen.findByText('Beto Ruiz')).closest('tr') as HTMLElement;
    const menu = await abrirMenu(usuario, fila);
    expect(within(menu).queryByRole('menuitem', { name: /marcar como ganada/i })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /marcar como perdida/i })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /cancelar solicitud/i })).not.toBeInTheDocument();
  });

  it('cancelar manda el id y el token anti-CSRF a /api/cotizacion/cancelar', async () => {
    const { llamadas } = mockFetch({ filas: [FILA_ESPERANDO] });
    const usuario = userEvent.setup();
    renderVista();

    const fila = (await screen.findByText('Ana Pérez')).closest('tr') as HTMLElement;
    const menu = await abrirMenu(usuario, fila);
    await usuario.click(within(menu).getByRole('menuitem', { name: /cancelar solicitud/i }));

    await waitFor(() => {
      const llamada = llamadas.find((l) => l.url.endsWith('/api/cotizacion/cancelar'));
      expect(llamada).toBeDefined();
    });
    const llamada = llamadas.find((l) => l.url.endsWith('/api/cotizacion/cancelar'))!;
    expect(JSON.parse(llamada.init!.body as string)).toEqual({ id: FILA_ESPERANDO.id });
    expect((llamada.init!.headers as Record<string, string>)['x-csrf-token']).toBe(CSRF_TOKEN);
  });

  it('un 401 al cancelar avisa que la sesión venció', async () => {
    mockFetch({ filas: [FILA_ESPERANDO], cancelarStatus: 401, cancelarRespuesta: { ok: false, error: 'Token anti-CSRF inválido.' } });
    const usuario = userEvent.setup();
    const { onSesionInvalida } = renderVista();

    const fila = (await screen.findByText('Ana Pérez')).closest('tr') as HTMLElement;
    const menu = await abrirMenu(usuario, fila);
    await usuario.click(within(menu).getByRole('menuitem', { name: /cancelar solicitud/i }));

    await waitFor(() => {
      expect(onSesionInvalida).toHaveBeenCalled();
    });
  });

  it('la lista de estados del filtro incluye "Esperando aprobación" y "Rechazada"', async () => {
    mockFetch({ filas: [] });
    renderVista();

    await waitFor(() => screen.getByLabelText(/filtrar por estado/i));
    const opciones = within(screen.getByLabelText(/filtrar por estado/i)).getAllByRole('option');
    const etiquetas = opciones.map((o) => o.textContent);
    expect(etiquetas).toContain('Esperando aprobación');
    expect(etiquetas).toContain('Rechazada');
  });
});
