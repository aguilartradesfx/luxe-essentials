import Image from 'next/image';
import { copy } from '@/content/copy';
import { Button } from '@/components/ui/Button';

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-navy/10 bg-[var(--lienzo)]/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Image src="/brand/logo-dark.svg" alt={copy.marca} width={92} height={86} priority />
        <nav aria-label={copy.nav.ariaLabel} className="hidden gap-8 md:flex">
          {copy.nav.enlaces.map((e) => (
            <a key={e.href} href={e.href} className="text-sm text-navy/80 hover:text-navy">
              {e.texto}
            </a>
          ))}
        </nav>
        <Button href="#cotizacion" className="px-5 py-2 text-xs">
          {copy.nav.cta}
        </Button>
      </div>
    </header>
  );
}
