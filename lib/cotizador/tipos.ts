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
