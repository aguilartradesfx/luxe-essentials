import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Cotizador from '@/app/cotizador/Cotizador';

describe('Cotizador', () => {
  it('empieza sin líneas y con el total en cero', () => {
    render(<Cotizador />);
    expect(screen.getByText(/₡0/)).toBeInTheDocument();
  });

  it('filtra el catálogo al escribir en el buscador', async () => {
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await usuario.type(screen.getByLabelText(/buscar/i), 'inserto');
    expect(screen.getByText(/inserto de duvet king/i)).toBeInTheDocument();
    expect(screen.queryByText(/filipina/i)).not.toBeInTheDocument();
  });

  it('muestra el motivo del descuento al alcanzar el umbral', async () => {
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await usuario.type(screen.getByLabelText(/buscar/i), 'set de 600 hilos king');
    await usuario.click(screen.getByRole('button', { name: /agregar/i }));
    const cantidad = screen.getByLabelText(/cantidad/i);
    await usuario.clear(cantidad);
    await usuario.type(cantidad, '16');
    expect(screen.getByText(/16 sets en Sets de cama → 10%/)).toBeInTheDocument();
  });

  it('avisa cuando se marca bordado especial', async () => {
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await usuario.click(screen.getByLabelText(/bordado especial/i));
    expect(screen.getByText(/se confirma contra muestra/i)).toBeInTheDocument();
  });

  it('nunca le pasa al motor una tasa que lo haga lanzar', async () => {
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await usuario.type(screen.getByLabelText(/buscar/i), 'set de 600 hilos king');
    await usuario.click(screen.getByRole('button', { name: /agregar/i }));
    // El selector ofrece valores fijos: no hay forma de escribir una tasa
    // inválida. Si esto se convierte en texto libre, esta prueba debe cambiar
    // a comprobar la normalización — no borrarse.
    const iva = screen.getByLabelText(/iva/i);
    expect(iva.tagName).toBe('SELECT');
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('no deja enviar sin correo del cliente', async () => {
    const usuario = userEvent.setup();
    render(<Cotizador />);
    await usuario.type(screen.getByLabelText(/buscar/i), 'set de 600 hilos king');
    await usuario.click(screen.getByRole('button', { name: /agregar/i }));
    expect(screen.getByRole('button', { name: /enviar cotización/i })).toBeDisabled();
  });
});
