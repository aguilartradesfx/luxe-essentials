import { z } from 'zod';
import { IVA_GENERAL } from '@/lib/cotizador/escalas';

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
  clave: z.string().min(1, 'Falta la clave.'),
  cliente: z.object({
    nombre: z.string().trim().min(1, 'Escribe el nombre del cliente.').max(120, 'Escribe un nombre más corto.'),
    empresa: z.string().trim().max(120, 'Escribe un nombre de empresa más corto.').optional(),
    email: z.string().trim().pipe(z.email('Escribe un correo válido.')),
  }, { message: 'Los datos del cliente deben ir en un objeto.' }),
  lineas: z
    .array(
      z.object({
        skuId: z.string().min(1, 'Falta el SKU de la línea.'),
        cantidad: z
          .number()
          .int('La cantidad debe ser un número entero.')
          .positive('La cantidad debe ser mayor que cero.')
          // Tope de cordura, no una regla de negocio: 10.000 unidades de un
          // mismo SKU ya es un pedido descomunal, y números mucho mayores
          // rompen `Number.isSafeInteger` en el total sin que nada lo avise.
          // Si algún día Luxe recibe un pedido más grande, que sea una
          // decisión consciente (subir este número), no una sorpresa.
          .max(10000, 'Revisa la cantidad: no puede superar 10.000 unidades por línea.'),
      }),
      { message: 'Las líneas deben ir en un arreglo.' },
    )
    .min(1, 'Agrega al menos una línea a la cotización.'),
  // El tope es la tasa general (`IVA_GENERAL`), no un número arbitrario: las
  // tasas reducidas de Costa Rica (1%, 2%, 4%) están todas por debajo de
  // ella, así que ninguna tasa real puede superarla. Luxe todavía confirma
  // cuáles reducidas le aplican, por eso se acepta cualquier valor en el
  // rango en vez de una lista fija de tasas.
  tasaIva: z
    .number()
    .min(0, 'La tasa de IVA no puede ser negativa.')
    .max(IVA_GENERAL, `La tasa de IVA no puede superar la tasa general (${IVA_GENERAL * 100}%).`)
    .optional(),
  bordadoEspecial: z.boolean({ message: 'Bordado especial debe ser verdadero o falso.' }).optional(),
  contactId: z.string().min(1).optional(),
});

export type CotizacionInput = z.infer<typeof cotizacionSchema>;

// Para la vista previa (Tarea 8): mismas líneas que `cotizacionSchema`, pero
// sin `cliente` ni `contactId` —la previsualización no guarda nada— y sin el
// `.min(1)` en `lineas`: la pantalla previsualiza también con el carrito
// vacío (total en cero), antes de que el vendedor agregue el primer SKU.
export const previsualizarSchema = z.object({
  clave: z.string().min(1, 'Falta la clave.'),
  lineas: z
    .array(
      z.object({
        skuId: z.string().min(1, 'Falta el SKU de la línea.'),
        cantidad: z
          .number()
          .int('La cantidad debe ser un número entero.')
          .positive('La cantidad debe ser mayor que cero.')
          .max(10000, 'Revisa la cantidad: no puede superar 10.000 unidades por línea.'),
      }),
      { message: 'Las líneas deben ir en un arreglo.' },
    )
    .default([]),
  tasaIva: z
    .number()
    .min(0, 'La tasa de IVA no puede ser negativa.')
    .max(IVA_GENERAL, `La tasa de IVA no puede superar la tasa general (${IVA_GENERAL * 100}%).`)
    .optional(),
  bordadoEspecial: z.boolean({ message: 'Bordado especial debe ser verdadero o falso.' }).optional(),
});

export type PrevisualizarInput = z.infer<typeof previsualizarSchema>;
