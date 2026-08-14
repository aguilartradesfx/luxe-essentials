import { copy } from '@/content/copy';
import { GlassCard } from '@/components/ui/GlassCard';
import { Figure } from '@/components/ui/Figure';
import { getMedia, type MediaId } from '@/content/media';

const GALERIA: MediaId[] = [
  'cocina-filipinas',
  'cocina-gorros-pantalones',
  'camisas-columbia',
  'camisas-industriales-reflectivo',
  'playeras-pantalones-industriales',
  'pantalones-denim-reflectivo',
  'polos-tejido-plano',
  'deportivas',
  'chalecos-corporativos',
  'chaquetas-ejecutivas',
  'set-medicos',
];

const IMAGEN_LINEA = {
  uniformes: 'cocina-linea-completa',
  hogar: 'hogar-cama-vestida',
} as const satisfies Record<string, MediaId>;

export function Lineas() {
  return (
    <section id="lineas" className="mx-auto max-w-6xl px-6 py-20">
      <h2 className="font-[family-name:var(--font-display)] text-3xl text-beige md:text-4xl">
        {copy.lineas.titulo}
      </h2>

      <div className="mt-12 grid gap-8 md:grid-cols-2">
        {copy.lineas.items.map((linea) => (
          <GlassCard key={linea.id} as="article" aria-label={linea.nombre} className="p-8">
            {/* Mismo tratamiento que el hero (Hero.tsx): placa clara +
                mix-blend-multiply, para que el fondo blanco de estudio de la
                foto se funda con la placa en vez de leerse como un recorte
                pegado sobre el navy (§8.2). */}
            <GlassCard variant="plate" className="mb-7 overflow-hidden p-6">
              <Figure id={IMAGEN_LINEA[linea.id]} sizes="(min-width: 768px) 50vw, 100vw" />
            </GlassCard>
            <p className="text-xs uppercase tracking-[0.2em] text-sky/80">{linea.marca}</p>
            <h3 className="mt-2 font-[family-name:var(--font-display)] text-2xl text-beige">
              {linea.nombre}
            </h3>
            <p className="mt-3 text-sky">{linea.descripcion}</p>
            <ul className="mt-6 space-y-2">
              {linea.categorias.map((cat) => (
                <li key={cat} className="flex gap-3 text-sm text-beige/90">
                  <span aria-hidden="true" className="text-teal">
                    —
                  </span>
                  {cat}
                </li>
              ))}
            </ul>
          </GlassCard>
        ))}
      </div>

      <h3 className="mt-20 font-[family-name:var(--font-display)] text-2xl text-beige">
        {copy.lineas.galeriaTitulo}
      </h3>
      <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {GALERIA.map((id) => (
          <GlassCard key={id} as="li" variant="plate" className="overflow-hidden p-3">
            <Figure id={id} sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw" />
            <p className="px-2 pb-1 pt-3 text-sm font-medium text-navy">{getMedia(id).brief}</p>
          </GlassCard>
        ))}
      </ul>
    </section>
  );
}
