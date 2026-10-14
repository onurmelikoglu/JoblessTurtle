import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

/** Kısa açıklama balonu; içerik tek bir odaklanabilir öğe olmalıdır. */
export function Tip({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content sideOffset={6} collisionPadding={8} className="z-[80] max-w-xs animate-fade-in rounded-lg bg-ink px-3 py-2 text-xs leading-relaxed text-page shadow-lg">
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
