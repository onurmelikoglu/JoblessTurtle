import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { TONE_SOFT, type Tone } from './tones';

export function Badge({ tone = 'neutral', icon, children, className, title }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONE_SOFT[tone], className)}>
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}
