import { copy } from '@/content/copy';
import { GlassCard } from '@/components/ui/GlassCard';

export function Personalizacion() {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-20">
      <GlassCard className="p-10 md:p-14">
        <h2 className="font-[family-name:var(--font-display)] text-3xl text-beige md:text-4xl">
          {copy.personalizacion.titulo}
        </h2>
        <p className="mt-5 max-w-2xl text-sky">{copy.personalizacion.descripcion}</p>
        <ul className="mt-8 flex flex-wrap gap-3">
          {copy.personalizacion.tecnicas.map((t) => (
            <li
              key={t}
              className="rounded-full border border-sky/30 px-5 py-2 text-sm text-beige"
            >
              {t}
            </li>
          ))}
        </ul>
      </GlassCard>
    </section>
  );
}
