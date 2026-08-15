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
  uniformes: 'seccion-uniformes',
  hogar: 'seccion-hogar',
} as const satisfies Record<string, MediaId>;

export function Lineas() {
  return (
    <section id="lineas" className="mx-auto max-w-6xl px-6 py-24">
      <h2 className="font-[family-name:var(--font-display)] text-3xl leading-tight text-navy md:text-4xl">
        {copy.lineas.titulo}
      </h2>

      <div className="mt-14 grid gap-10 md:grid-cols-2">
        {copy.lineas.items.map((linea) => (
          <article key={linea.id} aria-label={linea.nombre}>
            <Figure
              id={IMAGEN_LINEA[linea.id]}
              className="mb-8"
              sizes="(min-width: 768px) 50vw, 100vw"
            />
            <p className="text-xs uppercase tracking-[0.2em] text-navy/80">{linea.marca}</p>
            <h3 className="mt-3 font-[family-name:var(--font-display)] text-2xl text-navy">
              {linea.nombre}
            </h3>
            <p className="mt-3 leading-relaxed text-navy/75">{linea.descripcion}</p>
            <ul className="mt-7 space-y-2">
              {linea.categorias.map((cat) => (
                <li key={cat} className="flex gap-3 text-sm text-navy/80">
                  <span aria-hidden="true" className="text-teal">
                    —
                  </span>
                  {cat}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      <h3 className="mt-24 font-[family-name:var(--font-display)] text-2xl text-navy">
        {copy.lineas.galeriaTitulo}
      </h3>
      {/* Sobre lienzo claro las tomas de estudio con fondo blanco encajan
          solas: ya no hacen falta placas ni modos de fusión. */}
      <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {GALERIA.map((id) => (
          <GlassCard key={id} as="li" className="overflow-hidden p-3">
            <Figure id={id} sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw" />
            <p className="px-2 pb-1 pt-3 text-sm font-medium text-navy/80">{getMedia(id).brief}</p>
          </GlassCard>
        ))}
      </ul>
    </section>
  );
}
