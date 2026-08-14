import { copy } from '@/content/copy';
import { GlassCard } from '@/components/ui/GlassCard';

export function Cifras() {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-20">
      <ul className="grid gap-6 sm:grid-cols-3">
        {copy.cifras.map((c) => (
          <GlassCard key={c.etiqueta} as="li" className="px-8 py-10 text-center">
            <p className="font-[family-name:var(--font-display)] text-5xl text-beige">{c.valor}</p>
            <p className="mt-3 text-sm text-sky">{c.etiqueta}</p>
          </GlassCard>
        ))}
      </ul>
    </section>
  );
}
