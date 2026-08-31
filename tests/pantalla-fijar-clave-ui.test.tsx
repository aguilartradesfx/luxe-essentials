import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PantallaFijarClave } from '@/app/cotizador/PantallaFijarClave';

// Ronda de correcciones 1, hallazgo importante: esta pantalla vive en la
// única ruta del panel sin sesión previa, y hasta esta ronda no tenía ni una
// prueba propia. Mismo patrón que el `describe('PantallaClave', ...)` de
// tests/cotizador-ui.test.tsx: se monta el componente solo (sin `Panel`) y se
// simula el `fetch` que llama directamente, en vez de una prop inyectable —
// a diferencia de `PantallaClave`, esta pantalla arma la petición ella misma.

function respuestaFetch(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const CLAVE_BUENA = 'clave-larga-de-prueba';

describe('PantallaFijarClave', () => {
  let ubicacionOriginal: Location;

  beforeEach(() => {
    // jsdom no implementa navegación real: sin este stub, asignar
    // `window.location.href` imprime "Not implemented: navigation" en cada
    // prueba que llega a un 200, y no hay forma de comprobar a dónde
    // redirigió el componente.
    ubicacionOriginal = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: '' } as unknown as Location,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: ubicacionOriginal,
    });
    vi.restoreAllMocks();
  });

  // Mata el mutante que borra el `if (!enlace) { ... }` entero: sin él, el
  // formulario se mostraría igual con la URL vacía, y recién el servidor
  // rechazaría cada envío con el mismo 400 genérico de "enlace inválido" —
  // en vez de nunca llegar a intentarlo.
  it('sin enlace en la URL, no muestra el formulario y avisa que está incompleto', () => {
    render(<PantallaFijarClave enlace="" />);
    expect(screen.queryByLabelText(/^clave$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /elegir clave/i })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/incompleto/i);
  });

  it('con enlace en la URL, muestra el formulario', () => {
    render(<PantallaFijarClave enlace="abc123" />);
    expect(screen.getByLabelText(/^clave$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/repetir clave/i)).toBeInTheDocument();
  });

  it('lleva autoComplete="new-password" en los dos campos, con etiquetas visibles asociadas por htmlFor/id', () => {
    render(<PantallaFijarClave enlace="abc123" />);
    const clave = screen.getByLabelText(/^clave$/i);
    const repetir = screen.getByLabelText(/repetir clave/i);
    expect(clave).toHaveAttribute('autoComplete', 'new-password');
    expect(repetir).toHaveAttribute('autoComplete', 'new-password');
    expect(clave).toHaveAttribute('id', 'clave-nueva');
    expect(repetir).toHaveAttribute('id', 'clave-repetir');
  });

  // El propio comentario del componente dice que la comprobación de que
  // coincidan es para no gastar una derivación de scrypt en un caso que ya se
  // sabe inválido — `expect(fetch).not.toHaveBeenCalled()` es lo único que
  // ata esa decisión a una prueba: sin ella, alguien podría borrar el chequeo
  // temprano y dejar que el servidor rechace la discrepancia (que también
  // daría un error visible), y nada acá se pondría rojo.
  it('si las claves no coinciden, no llama al servidor', async () => {
    const fetchEspiado = vi.spyOn(globalThis, 'fetch');
    const usuario = userEvent.setup();
    render(<PantallaFijarClave enlace="abc123" />);

    await usuario.type(screen.getByLabelText(/^clave$/i), CLAVE_BUENA);
    await usuario.type(screen.getByLabelText(/repetir clave/i), 'otra-clave-distinta');
    await usuario.click(screen.getByRole('button', { name: /elegir clave/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no coinciden/i);
    expect(fetchEspiado).not.toHaveBeenCalled();
  });

  it('muestra el error que devuelve el servidor, anunciado con role="alert"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respuestaFetch(
        { ok: false, error: 'Este enlace ya venció o no es válido. Pedile a tu administrador que te mande uno nuevo.' },
        400,
      ),
    );
    const usuario = userEvent.setup();
    render(<PantallaFijarClave enlace="abc123" />);

    await usuario.type(screen.getByLabelText(/^clave$/i), CLAVE_BUENA);
    await usuario.type(screen.getByLabelText(/repetir clave/i), CLAVE_BUENA);
    await usuario.click(screen.getByRole('button', { name: /elegir clave/i }));

    const aviso = await screen.findByRole('alert');
    expect(aviso).toHaveTextContent(/venci|no es v[áa]lido/i);
    // No redirige en el camino de error.
    expect(window.location.href).toBe('');
  });

  it('al recibir 200, manda el enlace y la clave al servidor y redirige a /cotizador', async () => {
    const fetchEspiado = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(respuestaFetch({ ok: true, csrf: 'x', vendedor: 'Marta Vargas', rol: 'vendedor' }, 200));
    const usuario = userEvent.setup();
    render(<PantallaFijarClave enlace="abc123" />);

    await usuario.type(screen.getByLabelText(/^clave$/i), CLAVE_BUENA);
    await usuario.type(screen.getByLabelText(/repetir clave/i), CLAVE_BUENA);
    await usuario.click(screen.getByRole('button', { name: /elegir clave/i }));

    await waitFor(() => expect(window.location.href).toBe('/cotizador'));

    expect(fetchEspiado).toHaveBeenCalledWith(
      '/api/cotizacion/fijar-clave',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ enlace: 'abc123', clave: CLAVE_BUENA }),
      }),
    );
  });
});
