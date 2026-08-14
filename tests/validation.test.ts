import { describe, it, expect } from 'vitest';
import { leadSchema } from '@/lib/validation';

const valido = {
  nombre: 'Ana Pérez',
  email: 'ana@empresa.com',
  linea: 'uniformes',
};

describe('leadSchema', () => {
  it('acepta el mínimo requerido', () => {
    expect(leadSchema.safeParse(valido).success).toBe(true);
  });

  it('rechaza un correo inválido', () => {
    const r = leadSchema.safeParse({ ...valido, email: 'ana-arroba-empresa' });
    expect(r.success).toBe(false);
  });

  it('rechaza un nombre de una sola letra', () => {
    expect(leadSchema.safeParse({ ...valido, nombre: 'A' }).success).toBe(false);
  });

  it('rechaza una línea fuera del catálogo', () => {
    expect(leadSchema.safeParse({ ...valido, linea: 'muebles' }).success).toBe(false);
  });

  it('acepta cadenas vacías en los campos opcionales', () => {
    const r = leadSchema.safeParse({ ...valido, empresa: '', telefono: '', mensaje: '' });
    expect(r.success).toBe(true);
  });

  it('recorta los espacios del nombre', () => {
    const r = leadSchema.safeParse({ ...valido, nombre: '  Ana Pérez  ' });
    expect(r.success && r.data.nombre).toBe('Ana Pérez');
  });

  it('rechaza un mensaje desmedido', () => {
    const r = leadSchema.safeParse({ ...valido, mensaje: 'x'.repeat(2001) });
    expect(r.success).toBe(false);
  });

  it('conserva los parámetros utm', () => {
    const r = leadSchema.safeParse({ ...valido, utm: { utm_source: 'meta' } });
    expect(r.success && r.data.utm).toEqual({ utm_source: 'meta' });
  });
});
