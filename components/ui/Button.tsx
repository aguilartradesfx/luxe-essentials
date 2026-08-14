import Link from 'next/link';
import type { ReactNode } from 'react';

const BASE =
  'inline-flex items-center justify-center rounded-full px-7 py-3 text-sm font-medium tracking-wide transition-colors disabled:opacity-60 disabled:cursor-not-allowed';

// El primario es beige sobre navy (~8.3:1). Beige sobre teal da 3.9:1 y reprobaría AA.
const VARIANTS = {
  primary: 'bg-beige text-navy hover:bg-white',
  secondary: 'border border-sky/40 bg-white/5 text-beige backdrop-blur-md hover:bg-white/10',
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
