import Image from 'next/image';
import { getMedia, RATIO_CSS, type MediaId } from '@/content/media';

type FigureProps = {
  id: MediaId;
  priority?: boolean;
  className?: string;
  sizes?: string;
};

export function Figure({ id, priority = false, className = '', sizes = '100vw' }: FigureProps) {
  const entry = getMedia(id);
  const style = { aspectRatio: RATIO_CSS[entry.ratio] };

  if (entry.pending) {
    return (
      <div
        role="img"
        aria-label={entry.alt}
        style={style}
        className={`relative grid place-items-center overflow-hidden rounded-2xl border border-[var(--glass-border)] bg-gradient-to-br from-navy via-teal to-navy ${className}`}
      >
        <div className="px-6 text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-sky/80">Pendiente de fotografía</p>
          <p className="mt-2 font-[family-name:var(--font-display)] text-lg text-beige">{entry.brief}</p>
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
