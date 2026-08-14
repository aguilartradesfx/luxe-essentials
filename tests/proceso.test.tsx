import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Proceso } from '@/components/sections/Proceso';
import { Personalizacion } from '@/components/sections/Personalizacion';
import { Footer } from '@/components/sections/Footer';
import { copy } from '@/content/copy';

describe('Proceso', () => {
  it('lista los siete pasos en orden', () => {
    render(<Proceso />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(copy.proceso.pasos.length);
    copy.proceso.pasos.forEach((paso, i) => {
      expect(items[i]).toHaveTextContent(paso.nombre);
    });
  });

  it('numera cada paso', () => {
    render(<Proceso />);
    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByText('07')).toBeInTheDocument();
  });

  it('numera los pasos en sky, no en teal (2.67:1, reprueba AA incluso como texto grande)', () => {
    render(<Proceso />);
    const numero = screen.getByText('01');
    expect(numero).toHaveClass('text-sky');
    expect(numero.className).not.toMatch(/text-teal\b/);
  });
});

describe('Personalizacion', () => {
  it('nombra las cuatro técnicas', () => {
    render(<Personalizacion />);
    for (const t of copy.personalizacion.tecnicas) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
  });
});

describe('Footer', () => {
  it('es un contentinfo con el año actual', () => {
    render(<Footer />);
    const pie = screen.getByRole('contentinfo');
    expect(pie).toHaveTextContent(String(new Date().getFullYear()));
  });

  it('lista redes sociales junto al resto de datos de contacto (spec §5.8)', () => {
    render(<Footer />);
    expect(screen.getByRole('contentinfo')).toHaveTextContent(copy.footer.redes);
  });

  it('sitúa la empresa en Costa Rica y muestra el horario', () => {
    render(<Footer />);
    const pie = screen.getByRole('contentinfo');
    expect(pie).toHaveTextContent(copy.footer.direccion);
    expect(pie).toHaveTextContent(copy.footer.horario);
    // El cliente confirmó: la empresa es costarricense y no tiene bodega,
    // porque no maneja inventario. La planta que representan sí está en
    // Guatemala, pero es de su fabricante, no suya — por eso el pie sólo
    // indica el país de la empresa.
    expect(copy.footer.direccion).toBe('Costa Rica');
  });

  it('no atribuye a Luxe una planta ni una fabricación propias', () => {
    // El sitio afirmaba «planta propia», «no un intermediario» y «250
    // operarios en planta». Eran datos del fabricante al que representan.
    const todo = JSON.stringify(copy);
    for (const falso of ['planta propia', 'no un intermediario', 'sin subcontratar', '250']) {
      expect(todo.toLowerCase()).not.toContain(falso.toLowerCase());
    }
  });
});
