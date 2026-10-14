import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'tonal' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const BASE = 'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors duration-150 select-none disabled:opacity-50';
const SIZES: Record<ButtonSize, string> = { sm: 'h-8 px-3 text-[13px]', md: 'h-10 px-4 text-sm' };
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-on-brand enabled:hover:bg-brand-strong',
  tonal: 'bg-brand-soft text-brand-strong enabled:hover:bg-brand/20',
  outline: 'border border-line-strong bg-surface text-ink enabled:hover:bg-sunken',
  ghost: 'text-ink-soft enabled:hover:bg-sunken enabled:hover:text-ink',
  danger: 'border border-bad/50 bg-surface text-bad enabled:hover:bg-bad-soft',
};

function buttonClass(variant: ButtonVariant = 'outline', size: ButtonSize = 'md', className?: string) {
  return cn(BASE, SIZES[size], VARIANTS[variant], className);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant, size, loading = false, icon, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={buttonClass(variant, size, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

/** Dış bağlantı: her zaman yeni sekmede ve kaynak sayfaya erişim vermeden açılır. */
export function LinkButton({ variant, size, icon, className, children, ...rest }: LinkButtonProps) {
  return (
    <a target="_blank" rel="noopener noreferrer" className={buttonClass(variant, size, cn('hover:bg-sunken', className))} {...rest}>
      {icon}
      {children}
    </a>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: ButtonSize;
}

export function IconButton({ label, size = 'md', className, children, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn('inline-flex shrink-0 items-center justify-center rounded-lg text-ink-soft transition-colors duration-150 enabled:hover:bg-sunken enabled:hover:text-ink disabled:opacity-50', size === 'sm' ? 'size-8' : 'size-10', className)}
      {...rest}
    >
      {children}
    </button>
  );
}
