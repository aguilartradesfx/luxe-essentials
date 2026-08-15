import Link from 'next/link';
import type { ReactNode } from 'react';

const BASE =
  'inline-flex items-center justify-center rounded-full px-7 py-3 text-sm font-medium tracking-wide transition-colors disabled:opacity-60 disabled:cursor-not-allowed';

// Sobre lienzo claro la pareja de alto contraste se invierte respecto al
// diseño anterior: relleno navy con texto beige (~8.3:1). El teal sigue
// reservado a bordes y acentos — como texto no llega a AA.
const VARIANTS = {
  primary: 'bg-navy text-beige hover:bg-[#243343]',
  secondary: 'border border-navy/25 text-navy hover:bg-navy/5',
} as const;

type ButtonProps = {
  children: ReactNode;
  variant?: keyof typeof VARIANTS;
  href?: string;
  type?: 'button' | 'submit';
  disabled?: boolean;
  className?: string;
};

export function Button({
  children,
  variant = 'primary',
  href,
  type = 'button',
  disabled = false,
  className = '',
}: ButtonProps) {
  const cls = `${BASE} ${VARIANTS[variant]} ${className}`;
  if (href) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} disabled={disabled} className={cls}>
      {children}
    </button>
  );
}
