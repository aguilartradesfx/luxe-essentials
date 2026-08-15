import { copy } from '@/content/copy';
import { Figure } from '@/components/ui/Figure';

export function Proceso() {
  return (
    <section id="proceso" className="bg-[var(--lienzo-alt)]">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="grid items-end gap-12 md:grid-cols-2">
          <h2 className="font-[family-name:var(--font-display)] text-3xl leading-tight text-navy md:text-4xl">
            {copy.proceso.titulo}
          </h2>
          <Figure id="seccion-muestras" sizes="(min-width: 768px) 50vw, 100vw" />
        </div>

        <ol className="mt-16 grid gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-4">
          {copy.proceso.pasos.map((paso, i) => (
            <li key={paso.nombre} className="border-t border-navy/15 pt-5">
              <span className="font-[family-name:var(--font-display)] text-2xl text-teal">
                {String(i + 1).padStart(2, '0')}
              </span>
              <h3 className="mt-3 text-base font-medium text-navy">{paso.nombre}</h3>
              <p className="mt-2 text-sm leading-relaxed text-navy/80">{paso.detalle}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
