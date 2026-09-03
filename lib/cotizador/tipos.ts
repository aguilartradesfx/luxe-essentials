export const TALLAS = ['king', 'queen', 'doble', 'imperial'] as const;
export type Talla = (typeof TALLAS)[number];

// OJO: `lib/validation.ts` ya exporta un `LINEAS` distinto —con 'ambas'— para
// el formulario de leads. Este es el del catálogo y lleva otro nombre a
// propósito: dos exports homónimos con significados distintos es una trampa.
export const LINEAS_CATALOGO = ['uniformes', 'hogar'] as const;
export type LineaCatalogo = (typeof LINEAS_CATALOGO)[number];

// Los grupos que acumulan cantidad para el descuento. Un SKU pertenece a
// exactamente uno, y las cantidades solo se suman dentro del mismo grupo.
export const GRUPOS = [
  'uniformes',
  'sets-cama',
  'fundas-insertos',
  'toallas',
  'bata',
  'almohadas',
] as const;
export type GrupoDescuento = (typeof GRUPOS)[number];

export type Escalon = { desde: number; pct: number };

export type Escala = {
  grupo: GrupoDescuento;
  etiqueta: string;
  // Cómo se llama la unidad al explicarle el descuento al vendedor:
  // "16 sets → 10%" se lee mejor que "16 unidades → 10%".
  unidad: string;
  // Ordenados de mayor a menor `desde`. `escalonDe` devuelve el primero
  // que alcanza, así que el orden es parte del contrato.
  escalones: Escalon[];
};

export type Sku = {
  id: string;
  linea: LineaCatalogo;
  grupo: GrupoDescuento;
  // Agrupación visual en la pantalla y en la cotización. No afecta el cálculo.
  familia: string;
  nombre: string;
  talla?: Talla;
  precioLista: number;
  // Qué trae el juego, desglosado. Solo los sets de cama lo llevan: sin esto,
  // un hotel lee "set de 600 hilos king ₡90.000" y no sabe qué recibe.
  contenido?: string[];
};

export type LineaEntrada = { skuId: string; cantidad: number };

// Lo que un vendedor puede pedir fuera de las seis escalas automáticas
// (fase 5, descuento con aprobación — ver
// docs/superpowers/specs/2026-09-02-descuento-aprobacion-design.md y la
// migración 0017). Exactamente una de las dos formas, nunca las dos a la
// vez: son dos maneras de pedir el mismo tipo de cosa, no dos descuentos que
// se combinan — `lib/validation.ts` es quien hace valer eso en el borde.
//
// `familias` usa las claves de `GrupoDescuento` (el mismo grupo que ya
// acumula cantidad para el escalón automático en `calcular`), NO el campo
// `Sku.familia`: ese es una etiqueta libre de docenas de valores para
// agrupar visualmente el catálogo y no participa del cálculo del
// descuento. Un descuento "por familia" en el sentido de este tipo cae
// sobre un grupo entero de escala, igual que la escala misma.
export type DescuentoPersonalizado =
  | { general: number }
  | { familias: Partial<Record<GrupoDescuento, number>> };

// Tope de cordura para cualquier porcentaje de descuento personalizado,
// compartido entre `lib/cotizador/calcular.ts` (defensa interna, mismo
// criterio que la validación de `tasaIva` ahí) y `lib/validation.ts` (el
// borde real, donde llega el número que mandó el navegador). Un mismo
// número en los dos lugares evita que un cambio en uno se desalinee del
// otro sin que ninguna prueba lo note.
//
// El mínimo es 0, inclusive, y no hace falta una constante para eso: "puede
// ser menor que el de escala" (diseño) llega hasta cero, que es la escala
// más baja que existe -- cero no se prohíbe.
//
// El máximo es 100, EXCLUSIVO: a 100% el precio de la línea cae a cero, y
// eso es regalar el producto, no descontarlo -- casi siempre sería un error
// de tecleo (100 en vez de 10, o el dedo en la casilla equivocada), y este
// mecanismo no es la vía para regalar mercancía a propósito (eso sería una
// línea a precio cero explícito, otra herramienta). No es una tasa que Luxe
// pidió: es una defensa contra un número que nunca puede ser correcto.
export const DESCUENTO_PERSONALIZADO_MAX = 100;

export type LineaCalculada = {
  skuId: string;
  nombre: string;
  contenido?: string[];
  cantidad: number;
  precioLista: number;
  descuentoPct: number;
  precioUnitario: number;
  subtotal: number;
  grupo: GrupoDescuento;
  // Por qué se aplicó este descuento, en texto. La pantalla lo muestra para
  // que el vendedor detecte una escala mal configurada antes de enviar.
  motivo: string;
  // Si esta línea llevó el descuento personalizado en vez del de escala.
  // Opcional (no `false` por defecto en el tipo) para no romper fixtures ya
  // escritos a mano en otras pruebas que construyen `LineaCalculada` sin
  // este campo; `calcular` sí lo devuelve siempre, con su valor real.
  personalizado?: boolean;
};

export type Cotizacion = {
  lineas: LineaCalculada[];
  subtotal: number;
  ahorro: number;
  tasaIva: number;
  iva: number;
  total: number;
  bordadoEspecial: boolean;
};
