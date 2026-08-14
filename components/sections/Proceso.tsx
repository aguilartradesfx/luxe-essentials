import { copy } from '@/content/copy';
import { GlassCard } from '@/components/ui/GlassCard';

export function Proceso() {
  return (
    <section id="proceso" className="mx-auto max-w-6xl px-6 py-20">
      <h2 className="font-[family-name:var(--font-display)] text-3xl text-beige md:text-4xl">
        {copy.proceso.titulo}
      </h2>
      <ol className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {copy.proceso.pasos.map((paso, i) => (
          <GlassCard key={paso.nombre} as="li" className="p-6">
            <span className="font-[family-name:var(--font-display)] text-2xl text-teal">
              {String(i + 1).padStart(2, '0')}
            </span>
            <h3 className="mt-3 text-base font-medium text-beige">{paso.nombre}</h3>
            <p className="mt-2 text-sm text-sky">{paso.detalle}</p>
          </GlassCard>
        ))}
      </ol>
    </section>
  );
}
