import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Panel({ className, padded = true, ...rest }: HTMLAttributes<HTMLDivElement> & { padded?: boolean }) {
  return <div className={cn('rounded-xl border border-line bg-surface', padded && 'p-4 sm:p-5', className)} {...rest} />;
}

export function PanelTitle({ icon, children, action }: { icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <h2 className="min-w-0 flex-1 text-base font-semibold">{children}</h2>
      {action}
    </div>
  );
}
