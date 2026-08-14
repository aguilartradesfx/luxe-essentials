import { z } from 'zod';

export const LINEAS = ['uniformes', 'hogar', 'ambas'] as const;

const opcional = (max: number) => z.string().trim().max(max).optional();

export const leadSchema = z.object({
  nombre: z.string().trim().min(2, 'Escribe tu nombre completo.').max(120),
  empresa: opcional(120),
  email: z.email('Escribe un correo válido.'),
  telefono: opcional(40),
  linea: z.enum(LINEAS),
  cantidad: opcional(80),
  mensaje: opcional(2000),
  utm: z.record(z.string(), z.string()).optional(),
});

export type LeadInput = z.infer<typeof leadSchema>;
