import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return <LoaderCircle className={cn('size-4 shrink-0 animate-spin', className)} role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
