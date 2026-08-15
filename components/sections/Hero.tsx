import Image from 'next/image';
import { copy } from '@/content/copy';
import { Button } from '@/components/ui/Button';
import { getMedia } from '@/content/media';

const HERO = 'hero-tela';

export function Hero() {
  const foto = getMedia(HERO);

  return (
    <section className="relative isolate overflow-hidden">
      {/* La foto ocupa todo el bloque. En pantallas anchas su tercio
          izquierdo es pared beige limpia, y ahí es donde cae el texto. */}
      <div className="absolute inset-0 -z-10">
        <Image
          src={`/images/${HERO}.webp`}
          alt={foto.alt}
          fill
          priority
          sizes="100vw"
          className="object-cover object-[70%_center] md:object-center"
        />
        {/* Velo que sólo aclara el lado del texto; a partir de la mitad
            desaparece para no ensuciar la prenda. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-r from-[var(--lienzo)] via-[var(--lienzo)]/85 to-transparent md:via-[var(--lienzo)]/60 md:to-transparent"
        />
      </div>

      <div className="mx-auto flex min-h-[78vh] max-w-6xl items-center px-6 py-24 md:min-h-[88vh]">
        <div className="max-w-xl">
          <p className="text-xs uppercase tracking-[0.3em] text-navy/80">{copy.marca}</p>

          <h1 className="mt-6 font-[family-name:var(--font-display)] text-4xl leading-[1.1] text-navy md:text-6xl">
            {copy.hero.titulo}
          </h1>

          <p className="mt-7 text-lg leading-relaxed text-navy/75">{copy.hero.subtitulo}</p>

          <div className="mt-10 flex flex-wrap gap-4">
            <Button href="#cotizacion">{copy.hero.ctaPrimario}</Button>
            <Button href="#lineas" variant="secondary">
              {copy.hero.ctaSecundario}
            </Button>
          </div>

          <ul className="mt-12 flex flex-wrap gap-x-8 gap-y-3">
            {copy.hero.atributos.map((attr) => (
              <li key={attr} className="text-sm text-navy/80">
                {attr}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
