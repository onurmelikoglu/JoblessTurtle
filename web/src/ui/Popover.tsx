import * as RadixPopover from '@radix-ui/react-popover';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface PopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  title?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
  className?: string;
}

/**
 * Tetikleyicinin altında açılan içerik paneli. Dar ekranda kenarlara yaslanır (collisionPadding); yüksekliği ekranın
 * %70'ini ve tetikleyicinin altında kalan alanı aşmaz, içerik kayar.
 */
export function Popover({ trigger, children, title, open, onOpenChange, align = 'start', className }: PopoverProps) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            'z-[60] flex max-h-[min(70vh,var(--radix-popover-content-available-height))] w-[min(36rem,calc(100vw-24px))] animate-pop-in flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl outline-none',
            className,
          )}
        >
          {title && (
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <h2 className="text-sm font-semibold">{title}</h2>
              <RadixPopover.Close aria-label="Kapat" className="rounded-md p-1.5 text-ink-soft hover:bg-sunken hover:text-ink">
                <X className="size-4" aria-hidden />
              </RadixPopover.Close>
            </div>
          )}
          <div className="overflow-y-auto p-4">{children}</div>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
