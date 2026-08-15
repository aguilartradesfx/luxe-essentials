import { copy } from '@/content/copy';
import { GlassCard } from '@/components/ui/GlassCard';
import { QuoteForm } from '@/components/QuoteForm';

export function Cotizacion() {
  return (
    <section id="cotizacion" className="mx-auto max-w-3xl px-6 py-24">
      <GlassCard className="p-8 md:p-12">
        <h2 className="font-[family-name:var(--font-display)] text-3xl leading-tight text-navy md:text-4xl">
          {copy.formulario.titulo}
        </h2>
        <p className="mt-4 text-navy/75">{copy.formulario.descripcion}</p>
        <div className="mt-10">
          <QuoteForm />
        </div>
      </GlassCard>
    </section>
  );
}
