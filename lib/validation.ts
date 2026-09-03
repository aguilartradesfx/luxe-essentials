import { z } from 'zod';
import { IVA_GENERAL } from '@/lib/cotizador/iva';
import { DESCUENTO_PERSONALIZADO_MAX, GRUPOS } from '@/lib/cotizador/tipos';

export const LINEAS = ['uniformes', 'hogar', 'ambas'] as const;

const opcional = (max: number, message: string) =>
  z.string().trim().max(max, message).optional();

// Descuento personalizado con aprobación (fase 5, base — ver
// docs/superpowers/specs/2026-09-02-descuento-aprobacion-design.md). Llega
// desde el navegador, así que se valida con el mismo rigor que el resto de
// este archivo: nunca se confía en que el número viene bien.
//
// Mismo tope que el motor (`DESCUENTO_PERSONALIZADO_MAX` en
// lib/cotizador/tipos.ts, que `lib/cotizador/calcular.ts` también usa): el
// número vive en un solo lugar para que un cambio ahí no desalinee esta
// validación de la que de verdad hace valer el motor. [0, 100), igual que
// ahí: 0 no se prohíbe ("puede ser menor que el de escala", diseño), y a
// 100% el producto queda gratis, casi siempre por un error de tecleo — ver
// el razonamiento completo junto a esa constante.
const pctDescuentoPersonalizado = (etiqueta: string) =>
  z
    .number(`El descuento ${etiqueta} debe ser un número.`)
    .min(0, `El descuento ${etiqueta} no puede ser negativo.`)
    .lt(
      DESCUENTO_PERSONALIZADO_MAX,
      `El descuento ${etiqueta} no puede llegar al 100%: eso regala el producto, no lo descuenta.`,
    );

// Las claves de `familias` tienen que ser un `GrupoDescuento` real (los seis
// de lib/cotizador/tipos.ts, los mismos que ya acumulan cantidad para el
// escalón automático) y NO el campo `Sku.familia` de texto libre del
// catálogo — ver el comentario de `DescuentoPersonalizado` en tipos.ts. Se
// valida con `.refine` sobre las claves en vez de `z.partialRecord`
// enum-keyed: ese devuelve un mensaje genérico en inglés ("Invalid key in
// record") que rompería la consistencia del resto de los mensajes de este
// archivo — todos en español, todos accionables.
//
// Una clave que sea un grupo real pero sin ninguna línea de ese grupo en la
// cotización NO se rechaza acá a propósito: la vista previa llama a este
// mismo esquema en cada tecla, con las líneas que haya en pantalla en ese
// momento, y es habitual negociar el descuento antes de terminar de armar
// el carrito. `calcular` ya trata esa familia como un no-op inofensivo (ver
// ese archivo). Lo que sí se rechaza es una clave que no sea un grupo de
// verdad: un typo ahí sería un descuento que el vendedor pidió y que nunca
// se aplica, en silencio — y eso es peor que un error explícito.
const familiasDescuentoSchema = z
  .record(z.string(), pctDescuentoPersonalizado('de familia'))
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'El descuento por familia necesita al menos una familia.',
  })
  .refine((obj) => Object.keys(obj).every((clave) => (GRUPOS as readonly string[]).includes(clave)), {
    message: `Familia de descuento desconocida. Debe ser una de: ${GRUPOS.join(', ')}.`,
  });

// Decisión (fase 5): el descuento personalizado llega en una de dos formas
// -- general, o por familia -- NUNCA LAS DOS A LA VEZ. El diseño ya lo
// documenta así ("{ general: n } o { familias: {...} }", migración 0017):
// es una elección entre dos caminos, no dos descuentos que se combinan
// (sumarlos volvería el precio final impredecible, mismo motivo que en
// `calcular`). Si el navegador manda las dos claves a la vez -- o
// ninguna -- se rechaza entero en vez de adivinar cuál de las dos vale.
// `calcular` vuelve a revisar esto puertas adentro (mismo criterio que ya
// usa con `tasaIva`): esta es la validación real, esa es la última línea
// de defensa si algún día alguien llama al motor sin pasar por acá.
//
// El `.transform` final angosta el tipo de salida a la unión discriminada
// `DescuentoPersonalizado` (lib/cotizador/tipos.ts) -- la misma forma que
// espera `opciones.descuentoPersonalizado` en `calcular` -- para que quien
// arme la llamada no tenga que repetir el `if` de cuál de las dos claves
// vino.
export const descuentoPersonalizadoSchema = z
  .object({
    general: pctDescuentoPersonalizado('general').optional(),
    familias: familiasDescuentoSchema.optional(),
  })
  .strict()
  .superRefine((valor, ctx) => {
    const tieneGeneral = valor.general !== undefined;
    const tieneFamilias = valor.familias !== undefined;
    if (tieneGeneral === tieneFamilias) {
      ctx.addIssue({
        code: 'custom',
        message: 'El descuento personalizado debe traer "general" o "familias", no los dos ni ninguno.',
      });
    }
  })
  .transform((valor) =>
    valor.general !== undefined ? { general: valor.general } : { familias: valor.familias! },
  );

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
  // Opcional a propósito (Tarea 6, ronda de correcciones 1): esta clave ya
  // no es la única prueba de identidad. `autenticarPeticion`
  // (lib/autenticacion-cotizador.ts) exige clave O sesión por cookie ANTES
  // de llegar acá — si ninguna de las dos vale, la ruta ya respondió 401 y
  // este esquema ni se evalúa. Exigirla como `min(1)` bloquearía por
  // completo el flujo por cookie: el panel embebido en GoHighLevel no
  // manda ninguna clave una vez que tiene sesión.
  clave: z.string().optional(),
  cliente: z.object({
    nombre: z.string().trim().min(1, 'Escribe el nombre del cliente.').max(120, 'Escribe un nombre más corto.'),
    empresa: z.string().trim().max(120, 'Escribe un nombre de empresa más corto.').optional(),
    email: z.string().trim().pipe(z.email('Escribe un correo válido.')),
    // Opcionales a propósito (Tarea 5): un hotel que cotiza por correo puede
    // no tener todavía una dirección de entrega definida, y bloquear el
    // envío por eso sería estorbar. Van impresos en el PDF cuando existen
    // (lib/cotizador/documento.tsx).
    telefono: z.string().trim().max(40, 'Escribe un teléfono más corto.').optional(),
    direccion: z.string().trim().max(200, 'Escribe una dirección más corta.').optional(),
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
  // Ronda de correcciones 2 (hallazgo I1): cuando la cotización nace de un
  // borrador que dejó el agente de IA, la pantalla manda el id de esa fila
  // para que el servidor la cierre (estado 'convertida'). Sin esto, la fila
  // del agente se queda en 'borrador' para siempre y bloquea
  // `registrarIntencion` para ese contacto de por vida.
  borradorId: z.string().min(1).optional(),
  // "Modificar" (migración 0016): el id de la cotización que ésta reemplaza,
  // cuando el envío viene de esa acción en vez de "Crear" o "Duplicar".
  // `z.uuid()` y no `z.string().min(1)` como `borradorId`: este id sí vuelve
  // a la base en una consulta por columna `id` (uuid) -- un valor sin esa
  // forma revienta Postgres como 500 en vez de 400 (mismo motivo que en
  // /cerrar, /reenviar y /duplicar).
  reemplazaId: z.uuid('El id de la cotización a reemplazar no es válido.').optional(),
  // Fase 5 (descuento con aprobación, base): ver `descuentoPersonalizadoSchema`
  // más arriba para qué se valida y por qué. Opcional: la inmensa mayoría de
  // las cotizaciones sigue sin ningún descuento fuera de escala.
  descuentoPersonalizado: descuentoPersonalizadoSchema.optional(),
});

export type CotizacionInput = z.infer<typeof cotizacionSchema>;

// Para la vista previa (Tarea 8): mismas líneas que `cotizacionSchema`, pero
// sin `cliente` ni `contactId` —la previsualización no guarda nada— y sin el
// `.min(1)` en `lineas`: la pantalla previsualiza también con el carrito
// vacío (total en cero), antes de que el vendedor agregue el primer SKU.
export const previsualizarSchema = z.object({
  // Mismo motivo que en `cotizacionSchema`: la clave ya no es la única
  // vía, la valida `autenticarPeticion` antes de llegar acá.
  clave: z.string().optional(),
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
  // Mismo motivo que en `cotizacionSchema`: la vista previa tiene que poder
  // mostrar el efecto del descuento personalizado antes de que el vendedor
  // lo mande a aprobación.
  descuentoPersonalizado: descuentoPersonalizadoSchema.optional(),
});

export type PrevisualizarInput = z.infer<typeof previsualizarSchema>;
