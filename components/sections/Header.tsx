import Image from 'next/image';
import { copy } from '@/content/copy';
import { Button } from '@/components/ui/Button';

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-bg-deep/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Image src="/brand/logo-light.svg" alt={copy.marca} width={104} height={97} priority />
        <nav aria-label="Principal" className="hidden gap-8 md:flex">
          {copy.nav.enlaces.map((e) => (
            <a key={e.href} href={e.href} className="text-sm text-sky hover:text-beige">
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
