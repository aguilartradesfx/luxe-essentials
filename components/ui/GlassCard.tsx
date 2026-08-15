import type { ElementType, ReactNode } from 'react';

const BASE = 'rounded-2xl';

const VARIANTS = {
  // Vidrio de verdad: sólo sobre fotografía, que es lo único que da algo
  // que refractar. Sobre un fondo plano se vería como un rectángulo sucio.
  panel:
    'bg-[var(--panel-fill)] border border-[var(--panel-border)] backdrop-blur-xl text-navy shadow-[var(--carta-sombra)]',
  // Papel sobre lienzo: sin blur. Es lo que usa el resto del sitio.
  carta:
    'bg-[var(--carta-fill)] border border-[var(--carta-border)] text-navy shadow-[var(--carta-sombra)]',
  // Sin relleno: para bloques que sólo necesitan el radio y el borde.
  desnuda: 'border border-[var(--carta-border)] text-navy',
} as const;

type GlassCardProps = {
  children: ReactNode;
  variant?: keyof typeof VARIANTS;
  as?: ElementType;
  className?: string;
  // El resto pasa tal cual al elemento: `aria-label`, `id`, etc.
  [prop: string]: unknown;
};

export function GlassCard({
  children,
  variant = 'carta',
  as: Tag = 'div',
  className = '',
  ...rest
}: GlassCardProps) {
  return (
    <Tag className={`${BASE} ${VARIANTS[variant]} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}
