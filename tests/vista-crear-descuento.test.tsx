import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VistaCrear } from '@/app/cotizador/VistaCrear';

// Fase 5 (descuento con aprobación): pedir un descuento personalizado desde
// "Crear". Mismo patrón que tests/vista-crear-plantilla.test.tsx -- monta
// `VistaCrear` directo, sin pasar por `Panel`.

const SKUS = [{ id: 'set-600-king', nombre: 'set de 600 hilos king', familia: 'Sets de cama 600 hilos' }];

type OpcionesFetch = {
  crearRespuesta?: unknown;
};

function mockFetch(opciones: OpcionesFetch = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const cuerpo = init?.body ? JSON.parse(init.body as string) : {};

    if (url.endsWith('/api/cotizacion/borradores')) {
      return new Response(JSON.stringify({ ok: true, borradores: [] }), { status: 200 });
    }
    if (url.endsWith('/api/cotizacion/previsualizar')) {
      const totalSets = (cuerpo.lineas ?? [])
        .filter((l: { skuId: string }) => l.skuId === 'set-600-king')
        .reduce((acc: number, l: { cantidad: number }) => acc + l.cantidad, 0);
      // Réplica mínima: sin descuento personalizado, escala normal (16+ ->
      // 10%); con descuento personalizado, ESE reemplaza al de escala --
      // que es justo lo que estas pruebas necesitan poder distinguir.
      const dp = cuerpo.descuentoPersonalizado;
      const pct = dp && 'general' in dp ? dp.general : totalSets >= 16 ? 10 : 0;
      const precioUnitario = Math.round(90000 * (1 - pct / 100));
      const cantidad = totalSets || 0;
      const subtotal = precioUnitario * cantidad;
      return new Response(
        JSON.stringify({
          ok: true,
          cotizacion: {
            lineas: cantidad
              ? [
                  {
                    skuId: 'set-600-king',
                    nombre: 'set de 600 hilos king',
                    cantidad,
                    precioLista: 90000,
                    descuentoPct: pct,
                    precioUnitario,
                    subtotal,
                    grupo: 'sets-cama',
                    motivo: dp
                      ? `Descuento personalizado: ${pct}% (reemplaza el descuento de escala)`
                      : `${cantidad} sets en Sets de cama → ${pct}%`,
                    personalizado: Boolean(dp),
                  },
                ]
              : [],
            subtotal,
            ahorro: 0,
            tasaIva: cuerpo.tasaIva ?? 0.13,
            iva: Math.round(subtotal * (cuerpo.tasaIva ?? 0.13)),
            total: subtotal + Math.round(subtotal * (cuerpo.tasaIva ?? 0.13)),
            bordadoEspecial: false,
          },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/cotizacion')) {
      return new Response(
        JSON.stringify(
          opciones.crearRespuesta ?? {
            ok: true,
            id: 'cot-1',
            numero: 'COT-2026-0001',
            pdf: { ruta: '2026/COT-2026-0001.pdf' },
            correo: { resendId: 're_1' },
            ghl: { estimateId: 'est-1' },
          },
        ),
        { status: 200 },
      );
    }
    throw new Error(`Fetch no simulado en la prueba: ${url}`);
  });
}

async function agregarYEsperar(usuario: ReturnType<typeof userEvent.setup>) {
  await usuario.click(screen.getByRole('button', { name: /agregar/i }));
  await waitFor(() => {
    expect(screen.getByLabelText(/cantidad/i)).toHaveValue(1);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VistaCrear — descuento personalizado (fase 5)', () => {
  it('en reposo no muestra ningún aviso de reemplazo ni de aprobación', () => {
    mockFetch();
    render(<VistaCrear skus={SKUS} obtenerCsrf={() => 'csrf'} onSesionInvalida={vi.fn()} rol="vendedor" />);

    expect(screen.queryByText(/reemplaza/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/esperando la aprobación/i)).not.toBeInTheDocument();
  });

  it('elegir "por familia" muestra un campo por cada una de las seis familias', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<VistaCrear skus={SKUS} obtenerCsrf={() => 'csrf'} onSesionInvalida={vi.fn()} rol="vendedor" />);

    await usuario.click(screen.getByRole('radio', { name: /por familia/i }));
    expect(screen.getByLabelText(/^toallas$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^batas$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/sets de cama/i)).toBeInTheDocument();
  });

  it('pedir un % general avisa que reemplaza al de escala, no que se suma', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<VistaCrear skus={SKUS} obtenerCsrf={() => 'csrf'} onSesionInvalida={vi.fn()} rol="vendedor" />);

    await usuario.click(screen.getByRole('radio', { name: /% general/i }));
    expect(screen.getByText(/reemplaza/i)).toBeInTheDocument();
  });

  // Verificación por mutación: si alguien cambia "reemplaza" por "se suma"
  // (o borra la palabra), esta prueba no lo detecta por sí sola -- pero la
  // de arriba SÍ, porque busca justo esa palabra. Esta prueba en cambio
  // ancla que el mensaje distingue vendedor de superadmin (ver la
  // siguiente), que es la otra mitad del requisito.
  it('un vendedor ve que la cotización va a quedar esperando aprobación', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<VistaCrear skus={SKUS} obtenerCsrf={() => 'csrf'} onSesionInvalida={vi.fn()} rol="vendedor" />);

    await usuario.click(screen.getByRole('radio', { name: /% general/i }));
    expect(screen.getByText(/esperando la aprobación de un superadmin/i)).toBeInTheDocument();
    expect(screen.queryByText(/sale directo/i)).not.toBeInTheDocument();
  });

  it('un superadmin ve que sale directo, y que igual queda registrado', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<VistaCrear skus={SKUS} obtenerCsrf={() => 'csrf'} onSesionInvalida={vi.fn()} rol="superadmin" />);

    await usuario.click(screen.getByRole('radio', { name: /% general/i }));
    expect(screen.getByText(/sale directo/i)).toBeInTheDocument();
    expect(screen.queryByText(/esperando la aprobación/i)).not.toBeInTheDocument();
  });

  it('el botón dice "Pedir aprobación" en vez de "Cotizar y enviar" cuando un vendedor pide un descuento', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<VistaCrear skus={SKUS} obtenerCsrf={() => 'csrf'} onSesionInvalida={vi.fn()} rol="vendedor" />);

    expect(screen.getByRole('button', { name: /cotizar y enviar/i })).toBeInTheDocument();
    await usuario.click(screen.getByRole('radio', { name: /% general/i }));
    expect(screen.getByRole('button', { name: /pedir aprobación/i })).toBeInTheDocument();
  });

  it('la previsualización refleja el % pedido, reemplazando el de escala (no el de escala + el pedido)', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<VistaCrear skus={SKUS} obtenerCsrf={() => 'csrf'} onSesionInvalida={vi.fn()} rol="vendedor" />);

    await agregarYEsperar(usuario);
    await usuario.clear(screen.getByLabelText(/cantidad/i));
    await usuario.type(screen.getByLabelText(/cantidad/i), '20');

    // Sin descuento personalizado: 20 sets -> escala normal, 10%.
    await waitFor(() => {
      expect(screen.getByText(/20 sets en sets de cama → 10%/i)).toBeInTheDocument();
    });

    await usuario.click(screen.getByRole('radio', { name: /% general/i }));
    await usuario.type(screen.getByLabelText(/porcentaje general/i), '25');

    // Con el 25% pedido: el motivo ya no dice "10%" ni "escala", dice
    // "personalizado" -- REEMPLAZÓ el de escala, no lo sumó.
    await waitFor(() => {
      expect(screen.getByText(/descuento personalizado: 25%/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/20 sets en sets de cama/i)).not.toBeInTheDocument();
  });

  it('un porcentaje a medio escribir (mayor o igual a 100) bloquea el envío, con el error visible', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<VistaCrear skus={SKUS} obtenerCsrf={() => 'csrf'} onSesionInvalida={vi.fn()} rol="vendedor" />);

    await agregarYEsperar(usuario);
    await usuario.click(screen.getByRole('radio', { name: /% general/i }));
    await usuario.type(screen.getByLabelText(/porcentaje general/i), '100');

    expect(await screen.findByRole('alert')).toHaveTextContent(/menor que 100/i);
    expect(screen.getByRole('button', { name: /pedir aprobación/i })).toBeDisabled();
  });

  it('"por familia" sin ninguna familia completada bloquea el envío', async () => {
    mockFetch();
    const usuario = userEvent.setup();
    render(<VistaCrear skus={SKUS} obtenerCsrf={() => 'csrf'} onSesionInvalida={vi.fn()} rol="vendedor" />);

    await agregarYEsperar(usuario);
    await usuario.click(screen.getByRole('radio', { name: /por familia/i }));

    expect(screen.getByRole('button', { name: /pedir aprobación/i })).toBeDisabled();
  });

  it('manda descuentoPersonalizado en el envío final, y la respuesta "esperando_aprobacion" se explica en la pantalla', async () => {
    const fetchEspiado = mockFetch({
      crearRespuesta: {
        ok: true,
        id: 'cot-1',
        numero: 'COT-2026-0001',
        estado: 'esperando_aprobacion',
        aprobacion: { pendiente: true, avisoEnviado: true },
      },
    });
    const usuario = userEvent.setup();
    render(<VistaCrear skus={SKUS} obtenerCsrf={() => 'csrf'} onSesionInvalida={vi.fn()} rol="vendedor" />);

    await agregarYEsperar(usuario);
    await usuario.click(screen.getByRole('radio', { name: /% general/i }));
    await usuario.type(screen.getByLabelText(/porcentaje general/i), '20');
    await usuario.type(screen.getByLabelText(/nombre del cliente/i), 'Ana Pérez');
    await usuario.type(screen.getByLabelText(/correo del cliente/i), 'ana@hotel.com');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /pedir aprobación/i })).toBeEnabled();
    });
    await usuario.click(screen.getByRole('button', { name: /pedir aprobación/i }));

    await waitFor(() => {
      const llamada = fetchEspiado.mock.calls.find(
        ([entrada]) => (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/cotizacion'),
      );
      expect(llamada).toBeDefined();
    });
    const llamada = fetchEspiado.mock.calls.find(
      ([entrada]) => (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/cotizacion'),
    )!;
    const cuerpo = JSON.parse((llamada[1] as RequestInit).body as string);
    expect(cuerpo.descuentoPersonalizado).toEqual({ general: 20 });

    // Aparece dos veces a propósito: una en la nota del bloque "Descuento
    // personalizado" (que sigue visible, el vendedor no lo tocó) y otra en
    // el panel de resultado, que es la que esta prueba quiere confirmar.
    await waitFor(() => {
      expect(screen.getAllByText(/esperando la aprobación de un superadmin/i).length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByText(/cotización COT-2026-0001 guardada/i)).toBeInTheDocument();
    // Nunca dice que el correo salió -- todavía no se intentó.
    expect(screen.queryByText(/con el pdf adjunto/i)).not.toBeInTheDocument();
  });

  it('sin ningún descuento pedido, el envío final no manda descuentoPersonalizado', async () => {
    const fetchEspiado = mockFetch();
    const usuario = userEvent.setup();
    render(<VistaCrear skus={SKUS} obtenerCsrf={() => 'csrf'} onSesionInvalida={vi.fn()} rol="vendedor" />);

    await agregarYEsperar(usuario);
    await usuario.type(screen.getByLabelText(/nombre del cliente/i), 'Ana Pérez');
    await usuario.type(screen.getByLabelText(/correo del cliente/i), 'ana@hotel.com');
    await usuario.click(screen.getByRole('button', { name: /cotizar y enviar/i }));

    await waitFor(() => {
      const llamada = fetchEspiado.mock.calls.find(
        ([entrada]) => (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/cotizacion'),
      );
      expect(llamada).toBeDefined();
    });
    const llamada = fetchEspiado.mock.calls.find(
      ([entrada]) => (typeof entrada === 'string' ? entrada : entrada.toString()).endsWith('/api/cotizacion'),
    )!;
    const cuerpo = JSON.parse((llamada[1] as RequestInit).body as string);
    expect(cuerpo.descuentoPersonalizado).toBeUndefined();
  });
});
