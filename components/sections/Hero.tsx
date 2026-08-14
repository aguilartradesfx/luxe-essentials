import { copy } from '@/content/copy';
import { Button } from '@/components/ui/Button';
import { GlassCard } from '@/components/ui/GlassCard';
import { Figure } from '@/components/ui/Figure';

export function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-20 pt-16 md:pt-24">
      <div className="grid items-center gap-12 md:grid-cols-2">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-4xl leading-tight text-beige md:text-5xl">
            {copy.hero.titulo}
          </h1>
          <p className="mt-6 max-w-xl text-lg text-sky">{copy.hero.subtitulo}</p>
          <div className="mt-9 flex flex-wrap gap-4">
            <Button href="#cotizacion">{copy.hero.ctaPrimario}</Button>
            <Button href="#lineas" variant="secondary">
              {copy.hero.ctaSecundario}
            </Button>
          </div>
        </div>
        <GlassCard variant="plate" className="overflow-hidden p-6">
          <Figure
            id="corporativo-camisas-pantalones"
            priority
            sizes="(min-width: 768px) 50vw, 100vw"
          />
        </GlassCard>
      </div>

      <ul className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {copy.hero.atributos.map((attr) => (
          <GlassCard key={attr} as="li" className="px-5 py-4">
            <span className="text-sm text-beige">{attr}</span>
          </GlassCard>
        ))}
      </ul>
    </section>
  );
}
