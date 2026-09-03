import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VistaCrear } from '@/app/cotizador/VistaCrear';

// Ronda de correcciones 1 sobre la Tarea 10 (hallazgo importante): cuando
// "Duplicar" trae una línea cuyo SKU ya no está en el catálogo vigente (un
// producto descontinuado desde que se armó la cotización original), el
// servidor YA la rechazaba bien (calcular() lanza, 400, con el id en el
// mensaje) — el problema era la pantalla: `porId.get(...)` devolvía
// `undefined` y esa línea desaparecía en silencio del `.map` (`return
// null`), así que el vendedor veía un error mencionando un producto que no
// estaba en pantalla, sin botón para quitarlo, y la única salida era
// abandonar la cotización entera. Estas pruebas ejercitan `VistaCrear`
// directo (sin pasar por `Panel`), con una `plantilla` que trae ese SKU
// fantasma — el mismo camino real por el que aparece (Duplicar).

const SKUS = [{ id: 'set-600-king', nombre: 'set de 600 hilos king', familia: 'Sets de cama 600 hilos' }];

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/cotizacion/borradores')) {
      return new Response(JSON.stringify({ ok: true, borradores: [] }), { status: 200 });
    }
    if (url.endsWith('/api/cotizacion/previsualizar')) {
      // El motor real rechazaría un SKU inexistente con 400 -- no hace
      // falta reimplementarlo acá, solo que la pantalla no reviente con la
      // respuesta genérica que produciría ese caso.
      return new Response(JSON.stringify({ ok: false, error: 'SKU desconocido: fantasma-1' }), { status: 400 });
    }
    throw new Error(`Fetch no simulado en la prueba: ${url}`);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VistaCrear — línea de un producto descontinuado (Tarea 10, ronda de correcciones 1)', () => {
  it('se muestra marcada, con botón de quitar, y bloquea el envío mientras esté', async () => {
    mockFetch();
    const onPlantillaConsumida = vi.fn();
    render(
      <VistaCrear
        skus={SKUS}
        obtenerCsrf={() => null}
        onSesionInvalida={vi.fn()}
        plantilla={{
          cliente: { nombre: 'Ana Pérez', empresa: '', email: 'ana@hotel.com', telefono: '', direccion: '' },
          lineas: [{ skuId: 'fantasma-1', cantidad: 5 }],
        }}
        onPlantillaConsumida={onPlantillaConsumida}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/ya no disponible/i)).toBeInTheDocument();
    });
    // Se identifica el SKU: sin esto, el vendedor no puede saber a cuál de
    // las líneas del error se refiere el mensaje del servidor.
    expect(screen.getByText(/fantasma-1/)).toBeInTheDocument();

    // Bloquea el envío: no tiene sentido dejar avanzar un pedido que el
    // servidor va a rechazar seguro.
    expect(screen.getByRole('button', { name: /cotizar y enviar/i })).toBeDisabled();
    expect(screen.getByText(/ya no están en el catálogo/i)).toBeInTheDocument();

    expect(onPlantillaConsumida).toHaveBeenCalledTimes(1);
  });

  it('el botón "Quitar" de la línea descontinuada la saca de la cotización', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(
      <VistaCrear
        skus={SKUS}
        obtenerCsrf={() => null}
        onSesionInvalida={vi.fn()}
        plantilla={{
          cliente: { nombre: 'Ana Pérez', empresa: '', email: 'ana@hotel.com', telefono: '', direccion: '' },
          lineas: [{ skuId: 'fantasma-1', cantidad: 5 }],
        }}
        onPlantillaConsumida={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/ya no disponible/i)).toBeInTheDocument();
    });

    await usuario.click(screen.getByRole('button', { name: /quitar/i }));

    await waitFor(() => {
      expect(screen.queryByText(/ya no disponible/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/todavía no agregaste ningún producto/i)).toBeInTheDocument();
  });
});

// "Modificar" (migración 0016): la plantilla de "Duplicar" gana tres campos
// opcionales (`reemplazaId`, `reemplazaNumero`, `contactId`) cuando viene de
// esta acción en vez de "Duplicar" a secas. Mismo patrón del describe de
// arriba: `VistaCrear` directo, sin pasar por `Panel`.
const COTIZACION_FIJA = {
  lineas: [
    {
      skuId: 'set-600-king',
      nombre: 'set de 600 hilos king',
      cantidad: 12,
      precioLista: 90000,
      descuentoPct: 0,
      precioUnitario: 90000,
      subtotal: 1080000,
      grupo: 'sets-cama',
      motivo: 'sin descuento',
    },
  ],
  subtotal: 1080000,
  ahorro: 0,
  tasaIva: 0.13,
  iva: 140400,
  total: 1220400,
  bordadoEspecial: false,
};

function mockFetchEnvio() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/cotizacion/borradores')) {
      return new Response(JSON.stringify({ ok: true, borradores: [] }), { status: 200 });
    }
    if (url.endsWith('/api/cotizacion/previsualizar')) {
      return new Response(JSON.stringify({ ok: true, cotizacion: COTIZACION_FIJA }), { status: 200 });
    }
    if (url.endsWith('/api/cotizacion')) {
      return new Response(
        JSON.stringify({
          ok: true,
          id: 'cot-nueva',
          numero: 'COT-2026-0099',
          cotizacion: COTIZACION_FIJA,
          ghl: { estimateId: 'est-1' },
          pdf: { ruta: '2026/COT-2026-0099.pdf' },
          correo: { resendId: 're_1' },
        }),
        { status: 200 },
      );
    }
    throw new Error(`Fetch no simulado en la prueba: ${url}`);
  });
}

const PLANTILLA_DUPLICAR = {
  cliente: { nombre: 'Hotel Papagayo', empresa: '', email: 'reservas@papagayo.cr', telefono: '', direccion: '' },
  lineas: [{ skuId: 'set-600-king', cantidad: 12 }],
};

const PLANTILLA_MODIFICAR = {
  ...PLANTILLA_DUPLICAR,
  reemplazaId: 'aaaaaaaa-2222-4000-8000-000000000001',
  reemplazaNumero: 'COT-2026-0050',
  contactId: 'contacto-ghl-viejo',
};

describe('VistaCrear — "Modificar" (migración 0016)', () => {
  it('muestra un aviso con el número de la cotización que va a reemplazar', async () => {
    mockFetchEnvio();
    render(
      <VistaCrear
        skus={SKUS}
        obtenerCsrf={() => null}
        onSesionInvalida={vi.fn()}
        plantilla={PLANTILLA_MODIFICAR}
        onPlantillaConsumida={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/vas a reemplazar la cotización cot-2026-0050/i)).toBeInTheDocument();
    });
  });

  it('"Duplicar" a secas (sin reemplazaId) no muestra ningún aviso de reemplazo', async () => {
    mockFetchEnvio();
    render(
      <VistaCrear
        skus={SKUS}
        obtenerCsrf={() => null}
        onSesionInvalida={vi.fn()}
        plantilla={PLANTILLA_DUPLICAR}
        onPlantillaConsumida={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/nombre del cliente/i)).toHaveValue('Hotel Papagayo');
    });
    expect(screen.queryByText(/vas a reemplazar/i)).not.toBeInTheDocument();
  });

  it('el envío final manda reemplazaId y el contactId de la cotización vieja', async () => {
    const fetchEspiado = mockFetchEnvio();
    render(
      <VistaCrear
        skus={SKUS}
        obtenerCsrf={() => 'csrf-de-prueba'}
        onSesionInvalida={vi.fn()}
        plantilla={PLANTILLA_MODIFICAR}
        onPlantillaConsumida={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
    const usuario = userEvent.setup();
    await usuario.click(screen.getByRole('button', { name: /cotizar y enviar/i }));

    await waitFor(() => {
      expect(screen.getByText(/cotización guardada/i)).toBeInTheDocument();
    });

    const llamada = fetchEspiado.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion'),
    );
    expect(llamada).toBeDefined();
    const cuerpo = JSON.parse((llamada![1] as RequestInit).body as string);
    expect(cuerpo.reemplazaId).toBe(PLANTILLA_MODIFICAR.reemplazaId);
    expect(cuerpo.contactId).toBe(PLANTILLA_MODIFICAR.contactId);
  });

  // Mata el mutante "mandar siempre reemplazaId, venga o no de Modificar":
  // una cotización duplicada a secas no debe marcar ninguna fila vieja como
  // reemplazada.
  it('un envío que viene de "Duplicar" a secas no manda reemplazaId ni contactId', async () => {
    const fetchEspiado = mockFetchEnvio();
    render(
      <VistaCrear
        skus={SKUS}
        obtenerCsrf={() => 'csrf-de-prueba'}
        onSesionInvalida={vi.fn()}
        plantilla={PLANTILLA_DUPLICAR}
        onPlantillaConsumida={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
    const usuario = userEvent.setup();
    await usuario.click(screen.getByRole('button', { name: /cotizar y enviar/i }));

    await waitFor(() => {
      expect(screen.getByText(/cotización guardada/i)).toBeInTheDocument();
    });

    const llamada = fetchEspiado.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion'),
    );
    const cuerpo = JSON.parse((llamada![1] as RequestInit).body as string);
    expect('reemplazaId' in cuerpo).toBe(false);
    expect('contactId' in cuerpo).toBe(false);
  });

  // El riesgo concreto que motiva el `else` explícito del efecto de
  // `plantilla` en VistaCrear.tsx: esta vista NO se desmonta al cambiar de
  // pestaña (Panel.tsx), así que un vendedor puede "Modificar" una fila,
  // arrepentirse, volver a "Cotizaciones" y "Duplicar" OTRA fila sin que
  // `VistaCrear` se haya reiniciado nunca. Sin resetear `reemplazaActivo`
  // cuando la `plantilla` nueva no trae `reemplazaId`, el segundo envío
  // (una cotización que el vendedor arma pensando en "Duplicar") marcaría
  // como reemplazada una fila totalmente ajena.
  it('un "Duplicar" posterior sobre otra fila limpia el reemplazo que había quedado de un "Modificar" anterior', async () => {
    const fetchEspiado = mockFetchEnvio();
    const { rerender } = render(
      <VistaCrear
        skus={SKUS}
        obtenerCsrf={() => 'csrf-de-prueba'}
        onSesionInvalida={vi.fn()}
        plantilla={PLANTILLA_MODIFICAR}
        onPlantillaConsumida={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/vas a reemplazar la cotización cot-2026-0050/i)).toBeInTheDocument();
    });

    // Objeto NUEVO (no el mismo `PLANTILLA_DUPLICAR` de arriba, para que el
    // efecto -- que reacciona a la referencia -- lo tome como un cambio real.
    rerender(
      <VistaCrear
        skus={SKUS}
        obtenerCsrf={() => 'csrf-de-prueba'}
        onSesionInvalida={vi.fn()}
        plantilla={{ ...PLANTILLA_DUPLICAR }}
        onPlantillaConsumida={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText(/vas a reemplazar/i)).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cotizar y enviar/i })).not.toBeDisabled();
    });
    const usuario = userEvent.setup();
    await usuario.click(screen.getByRole('button', { name: /cotizar y enviar/i }));

    await waitFor(() => {
      expect(screen.getByText(/cotización guardada/i)).toBeInTheDocument();
    });

    const llamada = fetchEspiado.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : input.toString()).endsWith('/api/cotizacion'),
    );
    const cuerpo = JSON.parse((llamada![1] as RequestInit).body as string);
    expect('reemplazaId' in cuerpo).toBe(false);
  });
});
