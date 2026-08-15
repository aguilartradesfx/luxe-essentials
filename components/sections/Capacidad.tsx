import { copy } from '@/content/copy';
import { Figure } from '@/components/ui/Figure';

export function Capacidad() {
  return (
    <section id="capacidad" className="mx-auto max-w-6xl px-6 py-24 md:py-32">
      <div className="grid items-center gap-14 md:grid-cols-2">
        <Figure id="seccion-telas" sizes="(min-width: 768px) 50vw, 100vw" />
        <div>
          <h2 className="font-[family-name:var(--font-display)] text-3xl leading-tight text-navy md:text-4xl">
            {copy.capacidad.titulo}
          </h2>
          {copy.capacidad.parrafos.map((p) => (
            <p key={p} className="mt-6 leading-relaxed text-navy/75">
              {p}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}
