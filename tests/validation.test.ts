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
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Escribe un correo válido.');
    }
  });

  it('rechaza un nombre de una sola letra', () => {
    const r = leadSchema.safeParse({ ...valido, nombre: 'A' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Escribe tu nombre completo.');
    }
  });

  it('rechaza una línea fuera del catálogo', () => {
    const r = leadSchema.safeParse({ ...valido, linea: 'muebles' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Selecciona una línea válida: uniformes, hogar o ambas.');
    }
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
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('El mensaje es muy largo. Resúmelo un poco.');
    }
  });

  it('conserva los parámetros utm', () => {
    const r = leadSchema.safeParse({ ...valido, utm: { utm_source: 'meta' } });
    expect(r.success && r.data.utm).toEqual({ utm_source: 'meta' });
  });

  it('recorta los espacios del correo', () => {
    const r = leadSchema.safeParse({ ...valido, email: '  ana@empresa.com  ' });
    expect(r.success && r.data.email).toBe('ana@empresa.com');
  });

  it('rechaza un nombre demasiado largo', () => {
    const r = leadSchema.safeParse({ ...valido, nombre: 'x'.repeat(121) });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Escribe un nombre más corto.');
    }
  });

  it('rechaza un nombre de empresa demasiado largo', () => {
    const r = leadSchema.safeParse({ ...valido, empresa: 'x'.repeat(121) });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Escribe un nombre de empresa más corto.');
    }
  });

  it('rechaza un teléfono demasiado largo', () => {
    const r = leadSchema.safeParse({ ...valido, telefono: 'x'.repeat(41) });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Revisa el teléfono: es demasiado largo.');
    }
  });

  it('rechaza una cantidad demasiado larga', () => {
    const r = leadSchema.safeParse({ ...valido, cantidad: 'x'.repeat(81) });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Describe la cantidad en menos palabras.');
    }
  });

  it('rechaza parámetros utm con valor no-string', () => {
    const r = leadSchema.safeParse({ ...valido, utm: { utm_source: 123 } });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Los parámetros UTM deben ser texto.');
    }
  });
});
