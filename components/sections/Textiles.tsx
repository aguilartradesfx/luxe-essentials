import { copy } from '@/content/copy';
import { Figure } from '@/components/ui/Figure';

export function Textiles() {
  return (
    <section id="textiles" className="bg-[var(--lienzo-alt)]">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="grid items-end gap-12 md:grid-cols-2">
          <div>
            <h2 className="font-[family-name:var(--font-display)] text-3xl leading-tight text-navy md:text-4xl">
              {copy.textiles.titulo}
            </h2>
            <p className="mt-6 leading-relaxed text-navy/80">{copy.textiles.intro}</p>
          </div>
          <Figure id="textil-habitacion" sizes="(min-width: 768px) 50vw, 100vw" />
        </div>

        <dl className="mt-16 grid gap-x-12 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {copy.textiles.familias.map((f) => (
            <div key={f.nombre} className="border-t border-navy/15 pt-5">
              <dt className="text-base font-medium text-navy">{f.nombre}</dt>
              <dd className="mt-2 text-sm leading-relaxed text-navy/80">{f.detalle}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-16 grid gap-8 sm:grid-cols-3">
          <Figure id="textil-sabanas" ratio="4:3" sizes="(min-width: 640px) 33vw, 100vw" />
          <Figure id="textil-almohadas" ratio="4:3" sizes="(min-width: 640px) 33vw, 100vw" />
          <Figure id="textil-bano" ratio="4:3" sizes="(min-width: 640px) 33vw, 100vw" />
        </div>

        <div className="mt-16 border-t border-navy/15 pt-12">
          <h3 className="font-[family-name:var(--font-display)] text-2xl text-navy">
            {copy.textiles.medidasTitulo}
          </h3>
          <p className="mt-4 max-w-2xl leading-relaxed text-navy/80">
            {copy.textiles.medidasDetalle}
          </p>
          <ul className="mt-8 flex flex-wrap gap-3">
            {copy.textiles.medidas.map((m) => (
              <li key={m} className="rounded-full border border-navy/20 px-5 py-2 text-sm text-navy">
                {m}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
