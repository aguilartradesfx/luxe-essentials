export type MediaRatio = '16:9' | '4:3' | '3:4' | '1:1';

export type MediaEntry = {
  id: string;
  ratio: MediaRatio;
  alt: string;
  brief: string;
  // Required, not optional: MEDIA below is `as const satisfies readonly
  // MediaEntry[]`, which keeps each entry's own narrow literal type instead
  // of widening to MediaEntry. If `pending` were optional, an entry that
  // omits it would have no `pending` key at all in its inferred type — and
  // TypeScript refuses to read `.pending` on a union where some members
  // lack the property outright (breaks e.g. `MEDIA.filter((e) =>
  // !e.pending)`). Making it required forces every entry, present and
  // future, to state `pending: true` or `pending: false` explicitly, so a
  // missing value is a compile error here instead of a `tsc`/`next build`
  // failure that only makes sense after reading this comment.
  pending: boolean;
};

export const MEDIA = [
  {
    id: 'corporativo-camisas-pantalones',
    ratio: '16:9',
    alt: 'Hombre y mujer con camisa y pantalón corporativo, junto a camisas en gris, rojo, azul marino y blanco',
    brief: 'Camisas y pantalones corporativos con modelos',
    pending: false,
  },
  {
    id: 'planta-bordado',
    ratio: '16:9',
    alt: 'Operarias trabajando en máquinas bordadoras industriales de cabezales múltiples',
    brief: 'Área de bordado en operación',
    pending: false,
  },
  {
    id: 'cocina-linea-completa',
    ratio: '16:9',
    alt: 'Filipinas negra y blanca, delantal, gorro de chef, gorra, polo y pantalones de cocina',
    brief: 'Línea completa de uniformes de cocina',
    pending: false,
  },
  {
    id: 'cocina-filipinas',
    ratio: '16:9',
    alt: 'Filipinas de chef en negro, blanco, con vivo rosado, roja y de denim',
    brief: 'Variantes de filipina',
    pending: false,
  },
  {
    id: 'cocina-gorros-pantalones',
    ratio: '16:9',
    alt: 'Gorra negra, gorros de chef y pantalón de cocina con estampado pied-de-poule',
    brief: 'Gorros, gorras y pantalones de chef',
    pending: false,
  },
  {
    id: 'camisas-columbia',
    ratio: '16:9',
    alt: 'Camisa tipo Columbia en caqui, con variantes en azul marino, negro, gris, verde olivo y vinotinto',
    brief: 'Camisas tipo Columbia',
    pending: false,
  },
  {
    id: 'camisas-industriales-reflectivo',
    ratio: '16:9',
    alt: 'Camisas industriales con cinta reflectiva amarilla, en negro, azul marino, arena, gris y blanco',
    brief: 'Camisas industriales con reflectivo',
    pending: false,
  },
  {
    id: 'playeras-pantalones-industriales',
    ratio: '16:9',
    alt: 'Playera manga larga azul marino y pantalón cargo negro, ambos con cinta reflectiva',
    brief: 'Playeras y pantalones industriales',
    pending: false,
  },
  {
    id: 'pantalones-denim-reflectivo',
    ratio: '16:9',
    alt: 'Pantalones de denim azul con cinta reflectiva amarilla en las piernas',
    brief: 'Pantalones de denim con reflectivo',
    pending: false,
  },
  {
    id: 'polos-tejido-plano',
    ratio: '16:9',
    alt: 'Polo azul marino de frente y espalda, con muestrario de colores en interlock, warp piqué y piqué',
    brief: 'Polos de tejido plano y muestrario',
    pending: false,
  },
  {
    id: 'deportivas',
    ratio: '16:9',
    alt: 'Hoodie celeste, sudadera de cuarto de zipper, hoodie amarillo, vestido deportivo y blusa sin mangas',
    brief: 'Prendas deportivas',
    pending: false,
  },
  {
    id: 'chalecos-corporativos',
    ratio: '16:9',
    alt: 'Chaleco ejecutivo y chaleco enguatado en azul marino, de frente y espalda',
    brief: 'Chalecos corporativos',
    pending: false,
  },
  {
    id: 'chaquetas-ejecutivas',
    ratio: '16:9',
    alt: 'Chaquetas ejecutivas con cierre frontal en blanco, azul marino y negro',
    brief: 'Chaquetas ejecutivas',
    pending: false,
  },
  {
    id: 'set-medicos',
    ratio: '16:9',
    alt: 'Sets de médico de manga corta con pantalón, en negro, blanco y azul marino',
    brief: 'Sets de médicos',
    pending: false,
  },
  {
    id: 'hogar-cama-vestida',
    ratio: '3:4',
    alt: 'Cama vestida con set de sábanas y cubrecama de la línea de hogar',
    brief: 'Cama vestida con sábanas y cubrecama',
    pending: true,
  },
] as const satisfies readonly MediaEntry[];

export type MediaId = (typeof MEDIA)[number]['id'];

const INDEX = new Map(MEDIA.map((e) => [e.id, e]));

export function getMedia(id: MediaId): MediaEntry {
  const entry = INDEX.get(id);
  if (!entry) throw new Error(`Imagen desconocida en el manifest: ${id}`);
  return entry;
}

export const RATIO_CSS: Record<MediaRatio, string> = {
  '16:9': '16 / 9',
  '4:3': '4 / 3',
  '3:4': '3 / 4',
  '1:1': '1 / 1',
};
