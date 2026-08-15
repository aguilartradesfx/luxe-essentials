import { copy } from '@/content/copy';
import { Figure } from '@/components/ui/Figure';

export function Planta() {
  return (
    <section id="planta" className="mx-auto max-w-6xl px-6 py-24">
      <div className="max-w-2xl">
        <h2 className="font-[family-name:var(--font-display)] text-3xl leading-tight text-navy md:text-4xl">
          {copy.planta.titulo}
        </h2>
        <p className="mt-6 leading-relaxed text-navy/80">{copy.planta.intro}</p>
      </div>

      <div className="mt-14 grid gap-10 md:grid-cols-2">
        <Figure id="planta-diseno" sizes="(min-width: 768px) 50vw, 100vw" />
        <Figure id="planta-corte" sizes="(min-width: 768px) 50vw, 100vw" />
      </div>

      <dl className="mt-16 grid gap-x-12 gap-y-10 sm:grid-cols-2">
        {copy.planta.areas.map((area) => (
          <div key={area.nombre} className="border-t border-navy/15 pt-5">
            <dt className="text-base font-medium text-navy">{area.nombre}</dt>
            <dd className="mt-2 text-sm leading-relaxed text-navy/80">{area.detalle}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-20 border-t border-navy/15 pt-12">
        <h3 className="font-[family-name:var(--font-display)] text-2xl text-navy">
          {copy.planta.materialesTitulo}
        </h3>
        <p className="mt-4 max-w-2xl leading-relaxed text-navy/80">
          {copy.planta.materialesDetalle}
        </p>
        <ul className="mt-8 flex flex-wrap gap-3">
          {copy.planta.materiales.map((m) => (
            <li key={m} className="rounded-full border border-navy/20 px-5 py-2 text-sm text-navy">
              {m}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
