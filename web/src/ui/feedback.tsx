import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

export function EmptyState({ icon, children, action }: { icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center text-ink-soft">
      {icon && <div className="text-ink-faint [&>svg]:size-9">{icon}</div>}
      <p className="max-w-md text-sm">{children}</p>
      {action}
    </div>
  );
}

export function LoadingBlock({ label = 'Yükleniyor…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-sm text-ink-soft" role="status">
      <Spinner className="size-5" />
      {label}
    </div>
  );
}

export function InlineBusy({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-ink-soft" role="status">
      <Spinner />
      {children}
    </span>
  );
}

export function ProgressBar({ value, className }: { value: number | null; className?: string }) {
  const percent = value === null ? null : Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-neutral-soft', className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
      <div className={cn('h-full rounded-full bg-brand transition-[width] duration-300', percent === null && 'w-1/3 animate-shimmer')} style={percent === null ? undefined : { width: `${percent}%` }} />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-shimmer rounded-md bg-neutral-soft', className)} aria-hidden />;
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <dt className="w-20 shrink-0 text-ink-soft">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}
