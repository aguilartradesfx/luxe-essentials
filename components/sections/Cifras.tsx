import { copy } from '@/content/copy';

export function Cifras() {
  return (
    <section className="bg-[var(--lienzo-alt)]">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <ul className="grid gap-12 sm:grid-cols-3">
          {copy.cifras.map((c) => (
            <li key={c.etiqueta}>
              <p className="font-[family-name:var(--font-display)] text-5xl text-navy">{c.valor}</p>
              <p className="mt-3 text-sm leading-relaxed text-navy/80">{c.etiqueta}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
