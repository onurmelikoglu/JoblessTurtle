import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type DialogSize = 'sm' | 'md' | 'lg';

const WIDTH: Record<DialogSize, string> = { sm: 'sm:max-w-md', md: 'sm:max-w-xl', lg: 'sm:max-w-3xl' };

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  size?: DialogSize;
  /** İşlem sürerken dışarı tıklama ve Esc ile kapanmayı engeller. */
  locked?: boolean;
  children: ReactNode;
}

/** Masaüstünde ortalanmış pencere, telefonda tam ekran; gövde kayar, alt eylem çubuğu sabit kalır. */
export function Dialog({ open, onClose, title, description, footer, size = 'md', locked = false, children }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => !next && !locked && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 animate-fade-in bg-overlay" />
        <RadixDialog.Content
          className={cn(
            'fixed z-50 flex animate-pop-in flex-col bg-surface shadow-2xl outline-none',
            'inset-0 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[min(88dvh,860px)] sm:w-[calc(100vw-3rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:border-line',
            WIDTH[size],
          )}
        >
          <header className="flex items-start gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="text-base leading-snug font-semibold break-words">{title}</RadixDialog.Title>
              {description ? <RadixDialog.Description className="mt-1 text-sm text-ink-soft">{description}</RadixDialog.Description> : <RadixDialog.Description className="sr-only">{typeof title === 'string' ? title : 'Pencere'}</RadixDialog.Description>}
            </div>
            <RadixDialog.Close asChild>
              <button type="button" aria-label="Kapat" disabled={locked} className="-m-1.5 rounded-lg p-1.5 text-ink-soft hover:bg-sunken hover:text-ink disabled:opacity-50">
                <X className="size-5" aria-hidden />
              </button>
            </RadixDialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</footer>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
