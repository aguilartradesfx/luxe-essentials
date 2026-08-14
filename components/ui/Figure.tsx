import Image from 'next/image';
import { copy } from '@/content/copy';
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
        {/*
          Placa sólida en navy, no el degradado directo: el centro exacto de
          un `bg-gradient-to-br from-navy via-teal to-navy` cae siempre en el
          punto medio del degradado — teal puro — y ni text-sky ni text-beige
          en su color completo alcanzan AA sobre teal (spec §4.2: "Beige
          sobre teal ~3.9:1, sólo texto grande"; text-xs no lo es). Una placa
          navy detrás del texto lo deja sobre un fondo de contraste conocido
          (7.22:1 y 9.16:1) sin salir de la paleta ni depender de dónde caiga
          el texto dentro del degradado.
        */}
        <div className="rounded-xl bg-navy px-6 py-4 text-center">
          {/* text-sky, no text-sky/80 — mismo razonamiento que en Lineas.tsx:
              es texto real que el visitante lee (el marcador de "pendiente"
              en la tarjeta de textiles de hogar), no un adorno. */}
          <p className="text-xs uppercase tracking-[0.2em] text-sky">{copy.medios.pendiente}</p>
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
