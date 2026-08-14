export type MediaRatio = '16:9' | '4:3' | '3:4' | '1:1';

export type MediaEntry = {
  id: string;
  ratio: MediaRatio;
  alt: string;
  brief: string;
  pending?: true;
};

export const MEDIA = [
  {
    id: 'corporativo-camisas-pantalones',
    ratio: '16:9',
    alt: 'Hombre y mujer con camisa y pantalón corporativo, junto a camisas en gris, rojo, azul marino y blanco',
    brief: 'Camisas y pantalones corporativos con modelos',
    pending: undefined,
  },
  {
    id: 'planta-bordado',
    ratio: '16:9',
    alt: 'Operarias trabajando en máquinas bordadoras industriales de cabezales múltiples',
    brief: 'Área de bordado en operación',
    pending: undefined,
  },
  {
    id: 'cocina-linea-completa',
    ratio: '16:9',
    alt: 'Filipinas negra y blanca, delantal, gorro de chef, gorra, polo y pantalones de cocina',
    brief: 'Línea completa de uniformes de cocina',
    pending: undefined,
  },
  {
    id: 'cocina-filipinas',
    ratio: '16:9',
    alt: 'Filipinas de chef en negro, blanco, con vivo rosado, roja y de denim',
    brief: 'Variantes de filipina',
    pending: undefined,
  },
  {
    id: 'cocina-gorros-pantalones',
    ratio: '16:9',
    alt: 'Gorra negra, gorros de chef y pantalón de cocina con estampado pied-de-poule',
    brief: 'Gorros, gorras y pantalones de chef',
    pending: undefined,
  },
  {
    id: 'camisas-columbia',
    ratio: '16:9',
    alt: 'Camisa tipo Columbia en caqui, con variantes en azul marino, negro, gris, verde olivo y vinotinto',
    brief: 'Camisas tipo Columbia',
    pending: undefined,
  },
  {
    id: 'camisas-industriales-reflectivo',
    ratio: '16:9',
    alt: 'Camisas industriales con cinta reflectiva amarilla, en negro, azul marino, arena, gris y blanco',
    brief: 'Camisas industriales con reflectivo',
    pending: undefined,
  },
  {
    id: 'playeras-pantalones-industriales',
    ratio: '16:9',
    alt: 'Playera manga larga azul marino y pantalón cargo negro, ambos con cinta reflectiva',
    brief: 'Playeras y pantalones industriales',
    pending: undefined,
  },
  {
    id: 'pantalones-denim-reflectivo',
    ratio: '16:9',
    alt: 'Pantalones de denim azul con cinta reflectiva amarilla en las piernas',
    brief: 'Pantalones de denim con reflectivo',
    pending: undefined,
  },
  {
    id: 'polos-tejido-plano',
    ratio: '16:9',
    alt: 'Polo azul marino de frente y espalda, con muestrario de colores en interlock, warp piqué y piqué',
    brief: 'Polos de tejido plano y muestrario',
    pending: undefined,
  },
  {
    id: 'deportivas',
    ratio: '16:9',
    alt: 'Hoodie celeste, sudadera de cuarto de zipper, hoodie amarillo, vestido deportivo y blusa sin mangas',
    brief: 'Prendas deportivas',
    pending: undefined,
  },
  {
    id: 'chalecos-corporativos',
    ratio: '16:9',
    alt: 'Chaleco ejecutivo y chaleco enguatado en azul marino, de frente y espalda',
    brief: 'Chalecos corporativos',
    pending: undefined,
  },
  {
    id: 'chaquetas-ejecutivas',
    ratio: '16:9',
    alt: 'Chaquetas ejecutivas con cierre frontal en blanco, azul marino y negro',
    brief: 'Chaquetas ejecutivas',
    pending: undefined,
  },
  {
    id: 'set-medicos',
    ratio: '16:9',
    alt: 'Sets de médico de manga corta con pantalón, en negro, blanco y azul marino',
    brief: 'Sets de médicos',
    pending: undefined,
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
