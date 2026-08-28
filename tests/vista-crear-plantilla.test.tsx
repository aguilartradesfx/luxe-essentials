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
        clave=""
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
        clave=""
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
