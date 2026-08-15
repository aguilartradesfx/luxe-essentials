import Image from 'next/image';
import { copy } from '@/content/copy';

export function Footer() {
  return (
    <footer className="bg-navy text-beige">
      <div className="mx-auto grid max-w-6xl gap-12 px-6 py-16 sm:grid-cols-2">
        <div>
          <Image src="/brand/logo-light.svg" alt={copy.marca} width={84} height={78} />
          <p className="mt-6 max-w-xs text-sm text-sky">
            {copy.lineas.items.map((l) => l.nombre).join(' · ')}
          </p>
        </div>
        <div>
          <h2 className="text-sm font-medium text-beige">{copy.footer.contactoTitulo}</h2>
          <ul className="mt-5 space-y-2 text-sm text-sky">
            <li>{copy.footer.telefono}</li>
            <li>{copy.footer.email}</li>
            <li>{copy.footer.direccion}</li>
            <li>{copy.footer.horario}</li>
            <li>{copy.footer.redes}</li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/15 px-6 py-6 text-center text-xs text-sky">
        © {new Date().getFullYear()} {copy.footer.derechos}
      </div>
    </footer>
  );
}
