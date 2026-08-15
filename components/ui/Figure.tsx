import Image from 'next/image';
import { copy } from '@/content/copy';
import { getMedia, RATIO_CSS, type MediaId, type MediaRatio } from '@/content/media';

type FigureProps = {
  id: MediaId;
  /** Pisa la proporción del manifest. Sirve para igualar una fila cuyas
   *  imágenes tienen proporciones nativas distintas; el recorte lo resuelve
   *  `object-cover`. */
  ratio?: MediaRatio;
  priority?: boolean;
  className?: string;
  sizes?: string;
};

export function Figure({
  id,
  ratio,
  priority = false,
  className = '',
  sizes = '100vw',
}: FigureProps) {
  const entry = getMedia(id);
  const style = { aspectRatio: RATIO_CSS[ratio ?? entry.ratio] };

  if (entry.pending) {
    return (
      <div
        role="img"
        aria-label={entry.alt}
        style={style}
        className={`relative grid place-items-center overflow-hidden rounded-2xl border border-[var(--carta-border)] bg-[var(--lienzo-alt)] ${className}`}
      >
        {/*
          Todo el texto va en navy sobre lienzo claro. El teal queda fuera:
          medido sobre beige da 3.95:1, por debajo del 4.5:1 que AA pide para
          texto normal, y este rótulo es text-xs. Navy sobre blanco son
          10.44:1 y navy/80 sobre blanco 5.59:1.
        */}
        <div className="rounded-xl border border-dashed border-navy/25 bg-white px-6 py-4 text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-navy/80">{copy.medios.pendiente}</p>
          <p className="mt-2 font-[family-name:var(--font-display)] text-lg text-navy">
            {entry.brief}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={style} className={`relative overflow-hidden rounded-2xl ${className}`}>
      <Image
        src={`/images/${entry.id}.webp`}
        alt={entry.alt}
        fill
        sizes={sizes}
        priority={priority}
        className="object-cover"
      />
    </div>
  );
}
