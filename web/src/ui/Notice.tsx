import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type NoticeTone = 'info' | 'warn' | 'error';

const STYLE: Record<NoticeTone, string> = {
  info: 'border-brand/25 bg-brand-soft text-brand-strong',
  warn: 'border-warn/25 bg-warn-soft text-warn',
  error: 'border-bad/25 bg-bad-soft text-bad',
};

export function Notice({ tone = 'info', icon, children, action, className }: { tone?: NoticeTone; icon?: ReactNode; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3 text-sm', STYLE[tone], className)}>
      {icon}
      <p className="min-w-0 flex-1 basis-52 text-ink">{children}</p>
      {action}
    </div>
  );
}
