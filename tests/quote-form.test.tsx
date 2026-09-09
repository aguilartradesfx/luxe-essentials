import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuoteForm } from '@/components/QuoteForm';
import { copy } from '@/content/copy';

beforeEach(() => {
  vi.restoreAllMocks();
});

async function llenarMinimo(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(copy.formulario.campos.nombre), 'Ana Pérez');
  await user.type(screen.getByLabelText(copy.formulario.campos.email), 'ana@empresa.com');
  await user.selectOptions(screen.getByLabelText(copy.formulario.campos.linea), 'uniformes');
}

describe('QuoteForm', () => {
  it('asocia una etiqueta a cada campo', () => {
    render(<QuoteForm />);
    for (const etiqueta of Object.values(copy.formulario.campos)) {
      expect(screen.getByLabelText(new RegExp(etiqueta))).toBeInTheDocument();
    }
  });

  it('el select de línea trae un placeholder con texto, no una opción vacía sin etiqueta', () => {
    render(<QuoteForm />);
    const select = screen.getByLabelText(copy.formulario.campos.linea) as HTMLSelectElement;
    const placeholder = select.querySelector('option[value=""]') as HTMLOptionElement | null;
    expect(placeholder).not.toBeNull();
    expect(placeholder!.textContent).toBe(copy.formulario.lineaPlaceholder);
    expect(placeholder!.disabled).toBe(true);
  });

  it('muestra la confirmación tras un envío exitoso', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 201 }),
    );
    const user = userEvent.setup();
    render(<QuoteForm />);
    await llenarMinimo(user);
    await user.click(screen.getByRole('button', { name: copy.formulario.enviar }));

    await waitFor(() => {
      expect(screen.getByText(copy.formulario.exitoTitulo)).toBeInTheDocument();
    });
  });

  it('mueve el foco al mensaje de éxito (el formulario se desmonta, así que si nada lo mueve cae a <body>)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 201 }),
    );
    const user = userEvent.setup();
    render(<QuoteForm />);
    await llenarMinimo(user);
    await user.click(screen.getByRole('button', { name: copy.formulario.enviar }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveFocus();
    });
  });

  it('mueve el foco al primer campo que el servidor rechazó tras un 400', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, errores: { email: 'Escribe un correo válido.' } }),
        { status: 400 },
      ),
    );
    const user = userEvent.setup();
    render(<QuoteForm />);
    await llenarMinimo(user);
    await user.click(screen.getByRole('button', { name: copy.formulario.enviar }));

    await waitFor(() => {
      expect(screen.getByLabelText(copy.formulario.campos.email)).toHaveFocus();
    });
  });

  it('envía al endpoint correcto los datos que el visitante llenó', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));
    const user = userEvent.setup();
    render(<QuoteForm />);
    await llenarMinimo(user);
    await user.click(screen.getByRole('button', { name: copy.formulario.enviar }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/lead');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');

    // Si el `name` de un campo cambia sin querer, esto es lo único que lo
    // detectaría: las demás pruebas sólo miran el estado de la UI a partir
    // de una respuesta simulada, nunca lo que de verdad viaja al servidor.
    const cuerpo = JSON.parse(init.body as string);
    expect(cuerpo).toMatchObject({
      nombre: 'Ana Pérez',
      email: 'ana@empresa.com',
      linea: 'uniformes',
    });
  });

  it('muestra el error por campo que devuelve el servidor', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, errores: { email: 'Escribe un correo válido.' } }),
        { status: 400 },
      ),
    );
    const user = userEvent.setup();
    render(<QuoteForm />);
    await llenarMinimo(user);
    await user.click(screen.getByRole('button', { name: copy.formulario.enviar }));

    const error = await screen.findByText('Escribe un correo válido.');
    expect(error).toBeInTheDocument();
    // El campo queda asociado a su mensaje para lectores de pantalla.
    expect(screen.getByLabelText(copy.formulario.campos.email)).toHaveAttribute(
      'aria-describedby',
      error.id,
    );
  });

  it('no muestra el error genérico de servidor ante un 400 de validación', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, errores: { email: 'Escribe un correo válido.' } }), {
        status: 400,
      }),
    );
    const user = userEvent.setup();
    render(<QuoteForm />);
    await llenarMinimo(user);
    await user.click(screen.getByRole('button', { name: copy.formulario.enviar }));

    await screen.findByText('Escribe un correo válido.');
    expect(screen.queryByText(copy.formulario.errorGeneral)).not.toBeInTheDocument();
  });

  it('muestra el mensaje de error cuando el servidor falla', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false }), { status: 500 }),
    );
    const user = userEvent.setup();
    render(<QuoteForm />);
    await llenarMinimo(user);
    await user.click(screen.getByRole('button', { name: copy.formulario.enviar }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(copy.formulario.errorGeneral);
    });
  });

  it('desactiva el botón mientras envía', async () => {
    let resolver: (r: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise<Response>((r) => {
        resolver = r;
      }),
    );
    const user = userEvent.setup();
    render(<QuoteForm />);
    await llenarMinimo(user);
    await user.click(screen.getByRole('button', { name: copy.formulario.enviar }));

    expect(await screen.findByRole('button', { name: copy.formulario.enviando })).toBeDisabled();
    resolver(new Response(JSON.stringify({ ok: true }), { status: 201 }));
  });

  // I9 (revision-final-2.md): el honeypot tiene que existir en el DOM (un
  // bot que parsea el HTML crudo lo tiene que encontrar) pero quedar fuera
  // del camino de una persona real -- fuera del orden de tabulación y del
  // árbol de accesibilidad, y con un `name` que calza con
  // `lib/validation.ts`/`app/api/lead/route.ts`.
  it('el campo honeypot existe, está oculto del árbol de accesibilidad y fuera del tabulado', () => {
    render(<QuoteForm />);
    const campo = document.querySelector<HTMLInputElement>('input[name="paginaWeb"]');
    expect(campo).not.toBeNull();
    expect(campo).toHaveAttribute('tabindex', '-1');
    expect(campo!.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  // El camino feliz manda el campo vacío -- si alguien le pusiera un
  // `defaultValue` sin querer, esta prueba lo detecta antes que un bot.
  it('una persona real que llena el formulario normalmente manda "paginaWeb" vacío', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));
    const user = userEvent.setup();
    render(<QuoteForm />);
    await llenarMinimo(user);
    await user.click(screen.getByRole('button', { name: copy.formulario.enviar }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const cuerpo = JSON.parse(init.body as string);
    expect(cuerpo.paginaWeb).toBe('');
  });
});
