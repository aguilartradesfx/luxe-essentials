export type MediaRatio = '21:9' | '16:9' | '3:2' | '4:3' | '3:4' | '1:1';

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
    id: 'planta-bodega',
    ratio: '4:3',
    alt: 'Bodega de telas con estanterías altas llenas de rollos en azul marino, beige y blanco, y un montacargas en el pasillo',
    brief: 'Bodega de telas de la planta',
    pending: false,
  },
  {
    id: 'planta-confeccion',
    ratio: '16:9',
    alt: 'Vista elevada de un piso de confección con largas hileras de máquinas de coser y operarios trabajando',
    brief: 'Piso de confección',
    pending: false,
  },
  {
    id: 'planta-corte',
    ratio: '16:9',
    alt: 'Mesas de corte largas con tela azul marino extendida en capas y operarios trabajando a lo largo',
    brief: 'Área de corte',
    pending: false,
  },
  {
    id: 'planta-diseno',
    ratio: '4:3',
    alt: 'Estudio de patronaje: dos personas sobre una mesa de luz con patrones, y pantallas con trazos técnicos al fondo',
    brief: 'Diseño y patronaje',
    pending: false,
  },
  {
    id: 'planta-bordado',
    ratio: '4:3',
    alt: 'Hilera de máquinas bordadoras industriales de cabezales múltiples bordando sobre tela azul marino',
    brief: 'Bordado industrial',
    pending: false,
  },
  {
    id: 'hero-tela',
    ratio: '21:9',
    alt: 'Camisa corporativa azul marino y filipina de chef negra con vivo verde, en primer plano',
    brief: 'Portada: detalle de tela de uniforme',
    pending: false,
  },
  {
    id: 'seccion-telas',
    ratio: '4:3',
    alt: 'Rollos de tela azul marino, blanca, beige y cruda ordenados en una estantería iluminada',
    brief: 'Continuidad de materiales',
    pending: false,
  },
  {
    id: 'seccion-uniformes',
    ratio: '3:4',
    alt: 'Filipina de chef negra, camisa corporativa azul marino y delantal colgados en perchas de madera',
    brief: 'Línea de uniformes',
    pending: false,
  },
  {
    id: 'seccion-hogar',
    ratio: '3:4',
    alt: 'Cama de hotel vestida con ropa de cama blanca de algodón y cojines azul marino',
    brief: 'Línea de textiles institucionales',
    pending: false,
  },
  {
    id: 'seccion-bordado',
    ratio: '4:3',
    alt: 'Máquina bordadora industrial aplicando un bordado sobre tela azul marino',
    brief: 'Personalización con bordado',
    pending: false,
  },
  {
    id: 'seccion-muestras',
    ratio: '16:9',
    alt: 'Muestras de tela en azul marino, blanco, beige y verde sobre una mesa, junto a una cinta métrica',
    brief: 'Elección de tela y aprobación de muestra',
    pending: false,
  },
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
    id: 'equipo-luxe',
    ratio: '4:3',
    alt: 'Equipo de Luxe Essentials atendiendo a un cliente',
    brief: 'Equipo de Luxe Essentials (el cliente aún debe enviarla)',
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
  '21:9': '21 / 9',
  '16:9': '16 / 9',
  '3:2': '3 / 2',
  '4:3': '4 / 3',
  '3:4': '3 / 4',
  '1:1': '1 / 1',
};
