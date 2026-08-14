import Image from 'next/image';
import { copy } from '@/content/copy';

export function Footer() {
  return (
    <footer className="border-t border-white/10 bg-black/20">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 sm:grid-cols-2">
        <div>
          <Image src="/brand/logo-light.svg" alt={copy.marca} width={88} height={82} />
          <p className="mt-5 max-w-xs text-sm text-sky">
            {copy.lineas.items.map((l) => l.nombre).join(' · ')}
          </p>
        </div>
        <div>
          <h2 className="text-sm font-medium text-beige">{copy.footer.contactoTitulo}</h2>
          <ul className="mt-4 space-y-2 text-sm text-sky">
            <li>{copy.footer.telefono}</li>
            <li>{copy.footer.email}</li>
            <li>{copy.footer.direccion}</li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/10 px-6 py-6 text-center text-xs text-sky/70">
        © {new Date().getFullYear()} {copy.footer.derechos}
      </div>
    </footer>
  );
}
