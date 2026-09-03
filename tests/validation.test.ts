import { describe, it, expect } from 'vitest';
import { leadSchema, cotizacionSchema, previsualizarSchema, descuentoPersonalizadoSchema } from '@/lib/validation';

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

describe('descuentoPersonalizadoSchema (fase 5, descuento con aprobación)', () => {
  it('acepta un descuento general válido', () => {
    const r = descuentoPersonalizadoSchema.safeParse({ general: 15 });
    expect(r.success && r.data).toEqual({ general: 15 });
  });

  it('acepta un descuento por familia válido', () => {
    const r = descuentoPersonalizadoSchema.safeParse({ familias: { toallas: 20 } });
    expect(r.success && r.data).toEqual({ familias: { toallas: 20 } });
  });

  it('acepta un descuento general de 0% ("puede ser menor que el de escala")', () => {
    const r = descuentoPersonalizadoSchema.safeParse({ general: 0 });
    expect(r.success).toBe(true);
  });

  it('acepta 99.99% pero no exactamente 100% (el tope es exclusivo)', () => {
    // El límite exacto: si el máximo estuviera mal, un mutante que topara
    // antes (p. ej. >= 99) rechazaría 99.99 también, y esta prueba lo mata.
    expect(descuentoPersonalizadoSchema.safeParse({ general: 99.99 }).success).toBe(true);
    expect(descuentoPersonalizadoSchema.safeParse({ general: 100 }).success).toBe(false);
  });

  it('rechaza un descuento general negativo', () => {
    const r = descuentoPersonalizadoSchema.safeParse({ general: -5 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message === 'El descuento general no puede ser negativo.')).toBe(
        true,
      );
    }
  });

  it('rechaza un descuento general del 100%: "eso regala el producto"', () => {
    const r = descuentoPersonalizadoSchema.safeParse({ general: 100 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/no puede llegar al 100%/);
    }
  });

  it('rechaza una familia que no existe en el catálogo de grupos', () => {
    // "toallass" (typo) no es ningún GrupoDescuento real. Si esto pasara en
    // silencio, el vendedor pediría un descuento que nunca se aplica.
    const r = descuentoPersonalizadoSchema.safeParse({ familias: { toallass: 20 } });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('Familia de descuento desconocida'))).toBe(true);
    }
  });

  it('rechaza el objeto entero si UNA de varias familias no existe, aunque las demás sí', () => {
    // Distinto del caso anterior (una sola clave, inválida): acá hay dos
    // claves, una válida ("toallas") y una inválida ("toallass"). Si la
    // validación comprobara "alguna clave es válida" en vez de "todas las
    // claves son válidas", este objeto pasaría por la válida y el typo se
    // colaría en silencio. Mata específicamente ese mutante (`.every` mal
    // cambiado a `.some`), que la prueba anterior no distingue porque ahí
    // "alguna" y "todas" dan el mismo resultado con una sola clave.
    const r = descuentoPersonalizadoSchema.safeParse({ familias: { toallas: 10, toallass: 20 } });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('Familia de descuento desconocida'))).toBe(true);
    }
  });

  it('rechaza un porcentaje de familia fuera de rango, aunque la familia sí exista', () => {
    // Distingue del caso anterior: acá la familia es válida ("toallas"), lo
    // inválido es solo el número. Si el esquema solo revisara las claves y
    // nunca el valor, esta prueba (y no la de la familia inexistente) lo
    // detecta.
    const r = descuentoPersonalizadoSchema.safeParse({ familias: { toallas: 150 } });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/no puede llegar al 100%/);
    }
  });

  it('rechaza un objeto "familias" vacío', () => {
    const r = descuentoPersonalizadoSchema.safeParse({ familias: {} });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => i.message === 'El descuento por familia necesita al menos una familia.'),
      ).toBe(true);
    }
  });

  it('rechaza que lleguen "general" y "familias" a la vez', () => {
    // Decisión (fase 5): son dos formas alternativas de pedir lo mismo, no
    // dos descuentos que se combinan -- ver el comentario en
    // lib/validation.ts. Ambos valores son válidos por separado (10 y 5
    // están en rango, "toallas" es un grupo real): lo único inválido es
    // que vengan juntos, así que esta prueba no se confunde con las de
    // rango o de familia inexistente.
    const r = descuentoPersonalizadoSchema.safeParse({ general: 10, familias: { toallas: 5 } });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('no los dos ni ninguno'))).toBe(true);
    }
  });

  it('rechaza un objeto sin "general" ni "familias"', () => {
    const r = descuentoPersonalizadoSchema.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('no los dos ni ninguno'))).toBe(true);
    }
  });

  it('rechaza campos que no sean "general" ni "familias"', () => {
    const r = descuentoPersonalizadoSchema.safeParse({ general: 10, otraCosa: 1 });
    expect(r.success).toBe(false);
  });

  it('la salida no arrastra la otra clave con valor undefined', () => {
    // El `.transform` angosta a la unión discriminada de tipos.ts: si la
    // implementación devolviera `{ general: 10, familias: undefined }` en
    // vez de `{ general: 10 }`, esta prueba (con `toEqual`, sensible a
    // claves de más) lo detecta -- una prueba que solo mirara `data.general`
    // no lo haría.
    const rGeneral = descuentoPersonalizadoSchema.safeParse({ general: 10 });
    expect(rGeneral.success && Object.keys(rGeneral.data)).toEqual(['general']);
    const rFamilias = descuentoPersonalizadoSchema.safeParse({ familias: { bata: 8 } });
    expect(rFamilias.success && Object.keys(rFamilias.data)).toEqual(['familias']);
  });

  it('está disponible como campo opcional en cotizacionSchema y previsualizarSchema', () => {
    const base = {
      cliente: { nombre: 'Hotel Test', email: 'hotel@test.com' },
      lineas: [{ skuId: 'x', cantidad: 1 }],
    };
    // Sin descuento personalizado: sigue funcionando igual que hoy.
    expect(cotizacionSchema.safeParse(base).success).toBe(true);
    expect(previsualizarSchema.safeParse({ lineas: base.lineas }).success).toBe(true);
    // Con un descuento personalizado válido: se acepta y queda en el dato
    // parseado, listo para pasarlo a `calcular`.
    const conDescuento = { ...base, descuentoPersonalizado: { general: 12 } };
    const r = cotizacionSchema.safeParse(conDescuento);
    expect(r.success && r.data.descuentoPersonalizado).toEqual({ general: 12 });
    // Con uno inválido: la cotización entera se rechaza, no solo ese campo.
    const conDescuentoInvalido = { ...base, descuentoPersonalizado: { general: 200 } };
    expect(cotizacionSchema.safeParse(conDescuentoInvalido).success).toBe(false);
  });
});
