import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Cotizador from '@/app/cotizador/Panel';
import { VistaEquipo } from '@/app/cotizador/VistaEquipo';

// Tarea 6: la pestaña "Equipo". Dos niveles de prueba, mismo criterio que
// tests/panel-listado-ui.test.tsx:
//
// 1. `describe('Panel — pestaña equipo')` monta `Panel` entero (vía
//    `<Cotizador />`) con una sesión ya activa (cookie simulada, sin pasar
//    por el formulario de clave) para comprobar que el botón "Equipo" se
//    dibuja o no según el `rol` que trae la sonda de sesión
//    (`/api/cotizacion/catalogo`). Esto es lo único que le corresponde a
//    `Panel`: la pestaña se DIBUJA según el rol, pero eso es cosmético —
//    quien manipule el estado de React no gana nada, porque las cuatro
//    rutas de app/api/equipo/* releen la fila de quien hace la petición en
//    la base antes de actuar (ver el comentario en Panel.tsx). Por eso el
//    montaje de las dos pruebas de visibilidad es IDÉNTICO salvo por
//    `rol`: si cambiara algo más (skus, borradores, csrf), un rechazo por
//    ese otro motivo podría maquillar de "no se ve" un fallo que en
//    realidad es "el fetch nunca llegó a devolver nada".
//
// 2. `describe('VistaEquipo')` monta el componente solo, sin pasar por
//    `Panel` — mismo patrón que `VistaListado` en panel-listado-ui.test.tsx.

const CSRF_TOKEN = 'csrf-de-prueba';

type OpcionesPanel = { rol: 'vendedor' | 'superadmin' };

// Monta `Panel` con una sesión ya activa (cookie simulada desde el
// principio, como `sesionActiva` en tests/cotizador-ui.test.tsx) para no
// tener que pasar por el formulario de clave sólo para comprobar qué
// pestañas se dibujan. Lo único que cambia entre una llamada y otra de esta
// función es `opciones.rol` — swap del que dependen las dos pruebas de
// visibilidad, de acuerdo al comentario de arriba.
function mockFetchPanel(opciones: OpcionesPanel) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    void init;

    if (url.endsWith('/api/cotizacion/catalogo')) {
      return new Response(
        JSON.stringify({
          ok: true,
          skus: [],
          csrf: CSRF_TOKEN,
          vendedor: 'Guillermo Rojas',
          rol: opciones.rol,
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/cotizacion/borradores')) {
      return new Response(JSON.stringify({ ok: true, borradores: [] }), { status: 200 });
    }
    throw new Error(`Fetch no simulado en la prueba: ${url}`);
  });
}

describe('Panel — pestaña equipo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no muestra la pestaña de equipo a un vendedor', async () => {
    mockFetchPanel({ rol: 'vendedor' });
    render(<Cotizador />);

    await waitFor(() => {
      expect(screen.getByText(/sesión de guillermo rojas/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^equipo$/i })).not.toBeInTheDocument();
  });

  it('la muestra a un superadmin', async () => {
    mockFetchPanel({ rol: 'superadmin' });
    render(<Cotizador />);

    expect(await screen.findByRole('button', { name: /^equipo$/i })).toBeInTheDocument();
  });

  // Verificación por mutación (a mano): con `rol === 'superadmin'`
  // reemplazado por `true` en la condición de la pestaña, esta prueba sigue
  // en verde (obviamente: el vendedor de la primera prueba también dejaría
  // de ocultarla) — lo que la hace fallar es exactamente ese cambio, visto
  // desde la primera prueba de este describe.
  it('un superadmin puede entrar a la pestaña y ver la vista de equipo', async () => {
    // Mismo `mockFetchPanel` de las dos pruebas de arriba, con el único
    // endpoint extra que abrir la pestaña necesita.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      void init;
      if (url.endsWith('/api/cotizacion/catalogo')) {
        return new Response(
          JSON.stringify({ ok: true, skus: [], csrf: CSRF_TOKEN, vendedor: 'Guillermo Rojas', rol: 'superadmin' }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/cotizacion/borradores')) {
        return new Response(JSON.stringify({ ok: true, borradores: [] }), { status: 200 });
      }
      if (url.endsWith('/api/equipo/listar')) {
        return new Response(JSON.stringify({ ok: true, equipo: [] }), { status: 200 });
      }
      throw new Error(`Fetch no simulado en la prueba: ${url}`);
    });

    const usuario = userEvent.setup();
    render(<Cotizador />);
    const botonEquipo = await screen.findByRole('button', { name: /^equipo$/i });
    await usuario.click(botonEquipo);

    expect(await screen.findByText(/todavía no hay nadie en el equipo/i)).toBeInTheDocument();
  });
});

const FILA_INVITADA = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  correo: 'guillermo@luxe.cr',
  nombre: 'Guillermo Rojas',
  rol: 'vendedor' as const,
  activo: true,
  estado: 'invitada' as const,
  ultimo_acceso: null,
};

const FILA_ACTIVA = {
  id: 'a1b2c3d4-0000-4000-8000-000000000002',
  correo: 'marta@luxe.cr',
  nombre: 'Marta Vargas',
  rol: 'superadmin' as const,
  activo: true,
  estado: 'activa' as const,
  ultimo_acceso: '2026-08-20T10:00:00.000Z',
};

type OpcionesFetch = {
  equipo?: unknown[];
  listarStatus?: number;
  invitarRespuesta?: unknown;
  reenviarRespuesta?: unknown;
  estadoRespuesta?: unknown;
  estadoStatus?: number;
};

function mockFetch(opciones: OpcionesFetch = {}) {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.endsWith('/api/equipo/listar')) {
      const status = opciones.listarStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ ok: false, error: 'No tenés permiso para administrar el equipo.' }), {
          status,
        });
      }
      return new Response(JSON.stringify({ ok: true, equipo: opciones.equipo ?? [FILA_INVITADA] }), { status: 200 });
    }

    if (url.endsWith('/api/equipo/invitar')) {
      const cuerpoRespuesta = opciones.invitarRespuesta ?? { ok: true, correoEnviado: true };
      return new Response(JSON.stringify(cuerpoRespuesta), { status: 200 });
    }

    if (url.endsWith('/api/equipo/reenviar')) {
      const cuerpoRespuesta = opciones.reenviarRespuesta ?? { ok: true, correoEnviado: true };
      return new Response(JSON.stringify(cuerpoRespuesta), { status: 200 });
    }

    if (url.endsWith('/api/equipo/estado')) {
      const status = opciones.estadoStatus ?? 200;
      const cuerpoRespuesta = opciones.estadoRespuesta ?? { ok: true };
      return new Response(JSON.stringify(cuerpoRespuesta), { status });
    }

    throw new Error(`Fetch no simulado en la prueba: ${url}`);
  });
  return spy;
}

function renderVista(props: Partial<Parameters<typeof VistaEquipo>[0]> = {}) {
  const onSesionInvalida = vi.fn();
  render(<VistaEquipo obtenerCsrf={() => CSRF_TOKEN} onSesionInvalida={onSesionInvalida} {...props} />);
  return { onSesionInvalida };
}

describe('VistaEquipo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lista al equipo con su estado', async () => {
    mockFetch({ equipo: [FILA_INVITADA] });
    renderVista();

    expect(await screen.findByText('guillermo@luxe.cr')).toBeInTheDocument();
    expect(await screen.findByText(/invitada/i)).toBeInTheDocument();
  });

  it('invita a alguien y manda correo, nombre y rol', async () => {
    const fetchEspiado = mockFetch({ equipo: [] });
    const usuario = userEvent.setup();
    renderVista();

    await screen.findByText(/todavía no hay nadie en el equipo/i);

    await usuario.type(screen.getByLabelText(/correo/i), 'nuevo@luxe.cr');
    await usuario.type(screen.getByLabelText(/nombre/i), 'Nueva Persona');
    await usuario.click(screen.getByLabelText(/superadmin/i));
    await usuario.click(screen.getByRole('button', { name: /enviar invitaci/i }));

    await waitFor(() => {
      const llamadaInvitar = fetchEspiado.mock.calls.find(([entrada]) =>
        (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/equipo/invitar'),
      );
      expect(llamadaInvitar).toBeDefined();
    });
    const llamadaInvitar = fetchEspiado.mock.calls.find(([entrada]) =>
      (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/equipo/invitar'),
    )!;
    expect(JSON.parse((llamadaInvitar[1] as RequestInit).body as string)).toMatchObject({
      correo: 'nuevo@luxe.cr',
      nombre: 'Nueva Persona',
      rol: 'superadmin',
    });
  });

  // El correo que no sale es el modo de fallo más probable de esta
  // pantalla (brief, Tarea 6): la persona quedó creada, pero no se enteró.
  it('avisa cuando la persona quedó creada pero el correo no salió', async () => {
    mockFetch({ equipo: [], invitarRespuesta: { ok: true, correoEnviado: false } });
    const usuario = userEvent.setup();
    renderVista();

    await screen.findByText(/todavía no hay nadie en el equipo/i);

    await usuario.type(screen.getByLabelText(/correo/i), 'nuevo@luxe.cr');
    await usuario.type(screen.getByLabelText(/nombre/i), 'Nueva Persona');
    await usuario.click(screen.getByRole('button', { name: /enviar invitaci/i }));

    expect(await screen.findByText(/no se pudo enviar/i)).toBeInTheDocument();
  });

  // El mensaje de "no se pudo enviar" tiene que ser distinto del de éxito,
  // no una variación sutil del mismo texto — si no, alguien podría leerlo
  // de pasada y pensarlo un aviso más.
  it('cuando el correo SÍ sale, no muestra el aviso de "no se pudo enviar"', async () => {
    mockFetch({ equipo: [], invitarRespuesta: { ok: true, correoEnviado: true } });
    const usuario = userEvent.setup();
    renderVista();

    await screen.findByText(/todavía no hay nadie en el equipo/i);

    await usuario.type(screen.getByLabelText(/correo/i), 'nuevo@luxe.cr');
    await usuario.type(screen.getByLabelText(/nombre/i), 'Nueva Persona');
    await usuario.click(screen.getByRole('button', { name: /enviar invitaci/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/correo/i)).toHaveValue('');
    });
    expect(screen.queryByText(/no se pudo enviar/i)).not.toBeInTheDocument();
  });

  it('manda el token anti-CSRF al invitar', async () => {
    const fetchEspiado = mockFetch({ equipo: [] });
    const usuario = userEvent.setup();
    renderVista();

    await screen.findByText(/todavía no hay nadie en el equipo/i);

    await usuario.type(screen.getByLabelText(/correo/i), 'nuevo@luxe.cr');
    await usuario.type(screen.getByLabelText(/nombre/i), 'Nueva Persona');
    await usuario.click(screen.getByRole('button', { name: /enviar invitaci/i }));

    await waitFor(() => {
      const llamadaInvitar = fetchEspiado.mock.calls.find(([entrada]) =>
        (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/equipo/invitar'),
      );
      expect(llamadaInvitar).toBeDefined();
    });
    const llamadaInvitar = fetchEspiado.mock.calls.find(([entrada]) =>
      (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/equipo/invitar'),
    )!;
    expect((llamadaInvitar[1] as RequestInit & { headers: Record<string, string> }).headers['x-csrf-token']).toBe(
      CSRF_TOKEN,
    );
  });

  // Sólo `invitada`/`vencida` tienen una invitación pendiente de que
  // alguien la abra — a quien ya entró (`activa`) no se le reenvía nada.
  it('sólo ofrece "Reenviar invitación" a quien todavía no entró', async () => {
    mockFetch({ equipo: [FILA_INVITADA, FILA_ACTIVA] });
    renderVista();

    await screen.findByText('guillermo@luxe.cr');
    const filaInvitada = screen.getByText('guillermo@luxe.cr').closest('tr') as HTMLElement;
    const filaActiva = screen.getByText('marta@luxe.cr').closest('tr') as HTMLElement;

    expect(within(filaInvitada).getByRole('button', { name: /reenviar invitaci/i })).toBeInTheDocument();
    expect(within(filaActiva).queryByRole('button', { name: /reenviar invitaci/i })).not.toBeInTheDocument();
  });

  it('reenvía la invitación y avisa que se hizo', async () => {
    mockFetch({ equipo: [FILA_INVITADA] });
    const usuario = userEvent.setup();
    renderVista();

    const fila = (await screen.findByText('guillermo@luxe.cr')).closest('tr') as HTMLElement;
    await usuario.click(within(fila).getByRole('button', { name: /reenviar invitaci/i }));

    expect(await within(fila).findByText(/reenviada/i)).toBeInTheDocument();
  });

  it('"Desactivar" manda { activo: false } a /api/equipo/estado, y "Activar" a alguien inactivo manda { activo: true }', async () => {
    const fetchEspiado = mockFetch({ equipo: [FILA_ACTIVA, { ...FILA_INVITADA, activo: false, estado: 'desactivada' as const }] });
    const usuario = userEvent.setup();
    renderVista();

    const filaActiva = (await screen.findByText('marta@luxe.cr')).closest('tr') as HTMLElement;
    expect(within(filaActiva).getByRole('button', { name: /^desactivar$/i })).toBeInTheDocument();
    await usuario.click(within(filaActiva).getByRole('button', { name: /^desactivar$/i }));

    const filaInactiva = screen.getByText('guillermo@luxe.cr').closest('tr') as HTMLElement;
    expect(within(filaInactiva).getByRole('button', { name: /^activar$/i })).toBeInTheDocument();
    await usuario.click(within(filaInactiva).getByRole('button', { name: /^activar$/i }));

    await waitFor(() => {
      const llamadasEstado = fetchEspiado.mock.calls.filter(([entrada]) =>
        (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/equipo/estado'),
      );
      expect(llamadasEstado).toHaveLength(2);
    });
    const cuerpos = fetchEspiado.mock.calls
      .filter(([entrada]) => (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/equipo/estado'))
      .map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(cuerpos).toContainEqual({ id: FILA_ACTIVA.id, activo: false });
    expect(cuerpos).toContainEqual({ id: FILA_INVITADA.id, activo: true });
  });

  it('si el servidor rechaza dejar al equipo sin superadmin, muestra el error en la fila', async () => {
    mockFetch({
      equipo: [FILA_ACTIVA],
      estadoRespuesta: {
        ok: false,
        error: 'No se puede completar: dejaría al equipo sin su último superadmin activo.',
      },
      estadoStatus: 409,
    });
    const usuario = userEvent.setup();
    renderVista();

    const fila = (await screen.findByText('marta@luxe.cr')).closest('tr') as HTMLElement;
    await usuario.click(within(fila).getByRole('button', { name: /^desactivar$/i }));

    expect(await within(fila).findByText(/sin su último superadmin/i)).toBeInTheDocument();
  });

  it('un 401 avisa que la sesión venció, en vez de mostrar un error genérico', async () => {
    mockFetch({ listarStatus: 401 });
    const { onSesionInvalida } = renderVista();

    await waitFor(() => {
      expect(onSesionInvalida).toHaveBeenCalled();
    });
  });

  it('las etiquetas del formulario están asociadas por htmlFor/id', () => {
    mockFetch({ equipo: [] });
    renderVista();

    const correo = screen.getByLabelText(/correo/i);
    const nombre = screen.getByLabelText(/nombre/i);
    expect(correo).toHaveAttribute('id', 'equipo-correo');
    expect(nombre).toHaveAttribute('id', 'equipo-nombre');
  });

  it('la casilla de superadmin explica qué concede, de forma visible', () => {
    mockFetch({ equipo: [] });
    renderVista();

    expect(screen.getByText(/puede invitar y desactivar/i)).toBeInTheDocument();
  });
});
