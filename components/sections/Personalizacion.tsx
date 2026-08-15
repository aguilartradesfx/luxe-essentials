import { copy } from '@/content/copy';
import { Figure } from '@/components/ui/Figure';

export function Personalizacion() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <div className="grid items-center gap-14 md:grid-cols-2">
        <div className="md:order-2">
          <Figure id="planta-bordado" sizes="(min-width: 768px) 50vw, 100vw" />
        </div>
        <div className="md:order-1">
          <h2 className="font-[family-name:var(--font-display)] text-3xl leading-tight text-navy md:text-4xl">
            {copy.personalizacion.titulo}
          </h2>
          <p className="mt-6 leading-relaxed text-navy/75">{copy.personalizacion.descripcion}</p>
          <ul className="mt-8 flex flex-wrap gap-3">
            {copy.personalizacion.tecnicas.map((t) => (
              <li
                key={t}
                className="rounded-full border border-navy/20 px-5 py-2 text-sm text-navy"
              >
                {t}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
