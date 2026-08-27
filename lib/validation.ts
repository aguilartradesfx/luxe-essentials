import { z } from 'zod';

export const LINEAS = ['uniformes', 'hogar', 'ambas'] as const;

const opcional = (max: number, message: string) =>
  z.string().trim().max(max, message).optional();

export const leadSchema = z.object({
  nombre: z.string().trim().min(2, 'Escribe tu nombre completo.').max(120, 'Escribe un nombre más corto.'),
  empresa: opcional(120, 'Escribe un nombre de empresa más corto.'),
  email: z.string().trim().pipe(z.email('Escribe un correo válido.')),
  telefono: opcional(40, 'Revisa el teléfono: es demasiado largo.'),
  linea: z.enum(LINEAS, { message: 'Selecciona una línea válida: uniformes, hogar o ambas.' }),
  cantidad: opcional(80, 'Describe la cantidad en menos palabras.'),
  mensaje: opcional(2000, 'El mensaje es muy largo. Resúmelo un poco.'),
  utm: z.record(z.string(), z.string('Los parámetros UTM deben ser texto.'), { message: 'Los parámetros UTM deben ser texto.' }).optional(),
});

export type LeadInput = z.infer<typeof leadSchema>;

export const cotizacionSchema = z.object({
  clave: z.string().min(1),
  cliente: z.object({
    nombre: z.string().trim().min(1).max(120),
    empresa: z.string().trim().max(120).optional(),
    email: z.string().trim().pipe(z.email('Escribe un correo válido.')),
  }),
  lineas: z
    .array(
      z.object({
        skuId: z.string().min(1),
        cantidad: z.number().int().positive(),
      }),
    )
    .min(1),
  // Por defecto la tasa general. Se permite cualquier tasa entre 0 y 13%:
  // Costa Rica tiene reducidas, y Luxe todavía confirma cuáles le aplican.
  tasaIva: z.number().min(0).max(0.13).optional(),
  bordadoEspecial: z.boolean().optional(),
});

export type CotizacionInput = z.infer<typeof cotizacionSchema>;
