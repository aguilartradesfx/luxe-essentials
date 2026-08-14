import { copy } from '@/content/copy';
import { Figure } from '@/components/ui/Figure';

export function Capacidad() {
  return (
    <section id="capacidad" className="mx-auto max-w-6xl px-6 py-20">
      <div className="grid items-center gap-12 md:grid-cols-2">
        <Figure id="planta-bordado" sizes="(min-width: 768px) 50vw, 100vw" />
        <div>
          <h2 className="font-[family-name:var(--font-display)] text-3xl text-beige md:text-4xl">
            {copy.capacidad.titulo}
          </h2>
          {copy.capacidad.parrafos.map((p) => (
            <p key={p} className="mt-5 text-sky">
              {p}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}
