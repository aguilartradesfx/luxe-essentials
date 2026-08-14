import { z } from 'zod';

export const LINEAS = ['uniformes', 'hogar', 'ambas'] as const;

const opcional = (max: number) =>
  z.string().trim().max(max, `El campo no puede exceder ${max} caracteres.`).optional();

export const leadSchema = z.object({
  nombre: z.string().trim().min(2, 'Escribe tu nombre completo.').max(120, 'El nombre es demasiado largo.'),
  empresa: opcional(120),
  email: z.string().trim().pipe(z.email('Escribe un correo válido.')),
  telefono: opcional(40),
  linea: z.enum(LINEAS, { message: 'Selecciona una línea válida: uniformes, hogar o ambas.' }),
  cantidad: opcional(80),
  mensaje: opcional(2000),
  utm: z.record(z.string(), z.string(), { message: 'Los parámetros UTM deben ser texto.' }).optional(),
});

export type LeadInput = z.infer<typeof leadSchema>;
