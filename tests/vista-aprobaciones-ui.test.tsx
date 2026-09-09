import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Cotizador from '@/app/cotizador/Panel';
import { VistaAprobaciones } from '@/app/cotizador/VistaAprobaciones';
import { calcular } from '@/lib/cotizador/calcular';
import { CATALOGO } from '@/lib/cotizador/catalogo';
import { formatearColones } from '@/app/cotizador/formato';

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
  // Hallazgo crítico (revisión final): /pendientes ya manda `lineas` (y
  // `tasaIva`/`bordadoEspecial` dentro de `totales`) -- son las que la
  // pantalla necesita para pedirle al servidor el total resultante al
  // cambiar el porcentaje. `totales.total` sigue siendo un valor fijo de la
  // prueba (el total PEDIDO, mostrado en el encabezado de la tarjeta), sin
  // relación con `lineas` -- ninguna prueba de este archivo depende de que
  // los dos calcen.
  lineas: [{ skuId: 'set-600-king', cantidad: 16 }],
  totales: { total: 500000, tasaIva: 0.13, bordadoEspecial: false },
  descuento_personalizado: { general: 20 },
  solicitado_por: 'Guillermo Rojas',
};

const FILA_FAMILIAS = {
  id: 'a1b2c3d4-0000-4000-8000-000000000002',
  numero: 'COT-2026-0002',
  created_at: '2026-08-26T09:00:00.000Z', // 3 horas antes de AHORA
  cliente: { nombre: 'Beto Ruiz', empresa: 'Hotel Beto', email: 'beto@hotel.com' },
  lineas: [
    { skuId: 'toalla-680-bano', cantidad: 40 },
    { skuId: 'bata-blanca', cantidad: 20 },
  ],
  totales: { total: 300000, tasaIva: 0.13, bordadoEspecial: false },
  descuento_personalizado: { familias: { toallas: 10, bata: 5 } },
  solicitado_por: 'Marta Vargas',
};

type OpcionesFetch = {
  pendientes?: unknown[];
  aprobarRespuesta?: unknown;
  rechazarRespuesta?: unknown;
  // Hallazgo crítico: cuando falta, `/previsualizar` se simula con el motor
  // REAL (`calcular` + `CATALOGO`, los mismos que usa el servidor) sobre lo
  // que mandó el cuerpo de la petición -- así una prueba que no declara
  // nada especial igual obtiene un total correcto, y una que sí lo declara
  // puede forzar un error puntual.
  previsualizarRespuesta?: unknown;
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
    if (url.endsWith('/api/cotizacion/previsualizar')) {
      if (opciones.previsualizarRespuesta !== undefined) {
        return new Response(JSON.stringify(opciones.previsualizarRespuesta), { status: 200 });
      }
      const cuerpo = JSON.parse((init?.body as string) ?? '{}');
      try {
        const cotizacion = calcular(cuerpo.lineas ?? [], CATALOGO, {
          tasaIva: cuerpo.tasaIva,
          bordadoEspecial: cuerpo.bordadoEspecial,
          descuentoPersonalizado: cuerpo.descuentoPersonalizado,
        });
        return new Response(JSON.stringify({ ok: true, cotizacion }), { status: 200 });
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'No se pudo calcular.' }),
          { status: 400 },
        );
      }
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

  // I4 (revision-final-2.md): la ruta puede devolver `estado: 'error'`
  // cuando el descuento SÍ se aprobó pero el correo al hotel falló. Antes
  // esta pantalla pintaba "Aprobada ... tal cual se pidió" en los dos
  // casos, sin mirar `datos.estado` -- el superadmin no tenía forma de
  // saber, desde acá, que había algo pendiente de reenviar. Verificación
  // por mutación: si el `datos.estado === 'error'` de VistaAprobaciones.tsx
  // se borra (o se invierte), esta prueba se pone roja porque el aviso
  // vuelve a leer "Aprobada COT-2026-0001 tal cual se pidió" sin mención
  // del fallo.
  it('si el correo al hotel falló, el aviso NO dice sólo "tal cual se pidió": avisa que hay que reenviar', async () => {
    mockFetch({
      pendientes: [FILA_GENERAL],
      aprobarRespuesta: { ok: true, numero: FILA_GENERAL.numero, estado: 'error', cambioPorcentaje: false, avisoEnviado: true },
    });
    const usuario = userEvent.setup();
    renderVista();

    await usuario.click(await screen.findByRole('button', { name: /aprobar tal cual/i }));

    const aviso = await screen.findByText(/aprobada COT-2026-0001 tal cual se pidió/i);
    expect(aviso.textContent).toMatch(/correo al hotel falló/i);
    expect(aviso.textContent).toMatch(/reenviarla/i);
    // Mismo tratamiento visual que un error real (rojo), no el verde de un
    // envío que sí llegó -- ver `avisoGlobal.tipo === 'error'` en el JSX.
    expect(aviso.className).toMatch(/bg-red-50/);
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

  // Menor (revisión final): `Number('')` da `0`, no `NaN` -- un campo
  // BORRADO se colaba como un descuento general de 0% VÁLIDO, con el botón
  // de confirmar habilitado. Un 0% aprobado por descuido es el precio de
  // lista mandado como si fuera una oferta. Mata al mutante que quitara el
  // chequeo `if (crudo === '') return undefined`: sin él, el botón de abajo
  // quedaría HABILITADO con el campo vacío.
  it('borrar el campo de porcentaje NO se aprueba como 0% -- el botón de confirmar queda deshabilitado', async () => {
    mockFetch({ pendientes: [FILA_GENERAL] });
    const usuario = userEvent.setup();
    renderVista();

    await usuario.click(await screen.findByRole('button', { name: /cambiar % y aprobar/i }));
    const campo = screen.getByLabelText(/nuevo porcentaje general/i);
    await usuario.clear(campo);

    expect(campo).toHaveValue(null);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const confirmar = screen.getByRole('button', { name: /aprobar \(sin cambios\)/i });
    expect(confirmar).toBeDisabled();

    // Y no llega a pedir ninguna previsualización con ese "0%" inventado.
    const fetchImpl = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await new Promise((r) => setTimeout(r, 350));
    const llamadaPrevia = fetchImpl.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion/previsualizar'),
    );
    expect(llamadaPrevia).toBeUndefined();
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

  // Hallazgo crítico (revisión final): "Cambiar % y aprobar" mostraba el
  // total del descuento PEDIDO y nunca cambiaba -- el superadmin aprobaba un
  // porcentaje sin ver nunca a cuánto quedaba la cotización. Estas pruebas
  // anclan el arreglo: pedirle el total al SERVIDOR (nunca recalcularlo en
  // el navegador) y mostrarlo antes de aprobar.
  describe('vista previa del total al cambiar el porcentaje', () => {
    it('escribir un porcentaje nuevo pide el total a /previsualizar (con las mismas líneas) y lo muestra', async () => {
      const fetchEspiado = mockFetch({ pendientes: [FILA_GENERAL] });
      const usuario = userEvent.setup();
      renderVista();

      await usuario.click(await screen.findByRole('button', { name: /cambiar % y aprobar/i }));
      const campo = screen.getByLabelText(/nuevo porcentaje general/i);
      await usuario.clear(campo);
      await usuario.type(campo, '12');

      const totalReal = calcular(FILA_GENERAL.lineas, CATALOGO, {
        tasaIva: FILA_GENERAL.totales.tasaIva,
        bordadoEspecial: FILA_GENERAL.totales.bordadoEspecial,
        descuentoPersonalizado: { general: 12 },
      }).total;

      expect(
        await screen.findByText(`Total con este porcentaje: ${formatearColones(totalReal)}`),
      ).toBeInTheDocument();

      const llamadaPrevia = fetchEspiado.mock.calls.find(([entrada]) =>
        (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/cotizacion/previsualizar'),
      );
      expect(llamadaPrevia).toBeDefined();
      const cuerpo = JSON.parse((llamadaPrevia![1] as RequestInit).body as string);
      expect(cuerpo).toEqual({
        lineas: FILA_GENERAL.lineas,
        tasaIva: FILA_GENERAL.totales.tasaIva,
        bordadoEspecial: FILA_GENERAL.totales.bordadoEspecial,
        descuentoPersonalizado: { general: 12 },
      });
    });

    // El caso concreto de la revisión: 48 uniformes, pedido 20%, aprobado
    // 12% -- el total en pantalla tiene que ser el de 12%, no el de 20%.
    it('el total que se muestra es el del NUEVO porcentaje, no el pedido', async () => {
      mockFetch({ pendientes: [FILA_GENERAL] });
      const usuario = userEvent.setup();
      renderVista();

      await usuario.click(await screen.findByRole('button', { name: /cambiar % y aprobar/i }));
      const campo = screen.getByLabelText(/nuevo porcentaje general/i);
      await usuario.clear(campo);
      await usuario.type(campo, '12');

      const total12 = calcular(FILA_GENERAL.lineas, CATALOGO, {
        tasaIva: FILA_GENERAL.totales.tasaIva,
        bordadoEspecial: FILA_GENERAL.totales.bordadoEspecial,
        descuentoPersonalizado: { general: 12 },
      }).total;
      const total20 = calcular(FILA_GENERAL.lineas, CATALOGO, {
        tasaIva: FILA_GENERAL.totales.tasaIva,
        bordadoEspecial: FILA_GENERAL.totales.bordadoEspecial,
        descuentoPersonalizado: { general: 20 },
      }).total;
      expect(total12).not.toBe(total20); // si fueran iguales la prueba no probaría nada

      expect(await screen.findByText(`Total con este porcentaje: ${formatearColones(total12)}`)).toBeInTheDocument();
      expect(screen.queryByText(`Total con este porcentaje: ${formatearColones(total20)}`)).not.toBeInTheDocument();
    });

    it('un error del servidor al previsualizar se muestra tal cual, sin inventar un total', async () => {
      mockFetch({ pendientes: [FILA_GENERAL], previsualizarRespuesta: { ok: false, error: 'No se pudo calcular.' } });
      const usuario = userEvent.setup();
      renderVista();

      await usuario.click(await screen.findByRole('button', { name: /cambiar % y aprobar/i }));
      const campo = screen.getByLabelText(/nuevo porcentaje general/i);
      await usuario.clear(campo);
      await usuario.type(campo, '12');

      expect(await screen.findByText('No se pudo calcular.')).toBeInTheDocument();
      expect(screen.queryByText(/^Total con este porcentaje:/)).not.toBeInTheDocument();
    });

    it('cerrar la edición borra la vista previa -- no sobrevive a la fila siguiente', async () => {
      mockFetch({ pendientes: [FILA_GENERAL] });
      const usuario = userEvent.setup();
      renderVista();

      await usuario.click(await screen.findByRole('button', { name: /cambiar % y aprobar/i }));
      const campo = screen.getByLabelText(/nuevo porcentaje general/i);
      await usuario.clear(campo);
      await usuario.type(campo, '12');
      await screen.findByText(/^Total con este porcentaje:/);

      await usuario.click(screen.getByRole('button', { name: /^cancelar$/i }));
      expect(screen.queryByText(/^Total con este porcentaje:/)).not.toBeInTheDocument();
    });
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
