// tests/baja-ui.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PantallaBaja } from '@/app/baja/PantallaBaja';

function respuestaFetch(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('PantallaBaja', () => {
  // El hallazgo que esta tarea existe para evitar: un antivirus o un escáner
  // de correo que precarga enlaces (Outlook Safe Links, filtros
  // corporativos) hace un GET a esta página sin que la persona haya hecho
  // clic con intención. Si cargar la pantalla ejecutara la baja, ese GET
  // automático daría de baja a gente que nunca lo pidió. Esta prueba es la
  // que ata esa garantía al código: sólo MONTAR el componente, sin ninguna
  // interacción, no puede llamar a `fetch` bajo ningún concepto.
  it('al cargar, NO llama al servidor -- la baja no ocurre con sólo abrir la página', () => {
    const fetchEspiado = vi.spyOn(globalThis, 'fetch');
    render(<PantallaBaja token="token-de-prueba" correo="ana@hotel.com" />);
    expect(screen.getByText(/ana@hotel\.com/)).toBeInTheDocument();
    expect(fetchEspiado).not.toHaveBeenCalled();
  });

  it('muestra con qué correo se va a dar de baja, antes de cualquier confirmación', () => {
    render(<PantallaBaja token="token-de-prueba" correo="ana@hotel.com" />);
    expect(screen.getByText(/¿confirmás/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /no quiero recibir más correos/i })).toBeInTheDocument();
  });

  it('con un correo nulo (token inválido o ausente), no muestra el botón de confirmar', () => {
    render(<PantallaBaja token="" correo={null} />);
    expect(screen.queryByRole('button', { name: /no quiero recibir más correos/i })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/no es válido/i);
  });

  it('al tocar el botón, manda el token al endpoint de confirmar', async () => {
    const fetchEspiado = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respuestaFetch({ ok: true, correo: 'ana@hotel.com' }));
    const usuario = userEvent.setup();
    render(<PantallaBaja token="token-de-prueba" correo="ana@hotel.com" />);

    await usuario.click(screen.getByRole('button', { name: /no quiero recibir más correos/i }));

    expect(fetchEspiado).toHaveBeenCalledWith(
      '/api/baja/confirmar',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 'token-de-prueba' }),
      }),
    );
  });

  it('tras confirmar con éxito, muestra que la baja quedó hecha', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respuestaFetch({ ok: true, correo: 'ana@hotel.com' }));
    const usuario = userEvent.setup();
    render(<PantallaBaja token="token-de-prueba" correo="ana@hotel.com" />);

    await usuario.click(screen.getByRole('button', { name: /no quiero recibir más correos/i }));

    expect(await screen.findByText(/listo/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /no quiero recibir más correos/i })).not.toBeInTheDocument();
  });

  it('si el servidor responde con error, lo muestra y deja reintentar', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respuestaFetch({ ok: false, error: 'No pudimos procesar tu baja. Intentá de nuevo en un momento.' }, 500),
    );
    const usuario = userEvent.setup();
    render(<PantallaBaja token="token-de-prueba" correo="ana@hotel.com" />);

    await usuario.click(screen.getByRole('button', { name: /no quiero recibir más correos/i }));

    const aviso = await screen.findByRole('alert');
    expect(aviso).toHaveTextContent(/no pudimos procesar/i);
    // Sigue mostrando el botón: la persona puede reintentar.
    expect(screen.getByRole('button', { name: /no quiero recibir más correos/i })).toBeInTheDocument();
  });

  it('si la red falla, muestra un aviso genérico', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('sin red'));
    const usuario = userEvent.setup();
    render(<PantallaBaja token="token-de-prueba" correo="ana@hotel.com" />);

    await usuario.click(screen.getByRole('button', { name: /no quiero recibir más correos/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no pudimos conectar/i);
  });
});
