import type { ElementType, ReactNode } from 'react';

const BASE =
  'rounded-2xl border border-[var(--glass-border)] shadow-[var(--glass-shadow)] backdrop-blur-xl';

const VARIANTS = {
  dark: 'bg-[var(--glass-fill)] text-beige',
  plate: 'bg-[var(--plate-fill)] text-navy',
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
  variant = 'dark',
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
