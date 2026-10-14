import { cn } from '@/lib/cn';
import markUrl from './turtle-mark.svg';

export const BRAND_NAME = 'Jobless Turtle';

export function LogoMark({ className }: { className?: string }) {
  return <img src={markUrl} alt="" aria-hidden className={cn('size-8 shrink-0', className)} />;
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-semibold tracking-tight', className)}>
      Jobless <span className="text-brand">Turtle</span>
    </span>
  );
}
