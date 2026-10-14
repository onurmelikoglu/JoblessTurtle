import * as Dropdown from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface MenuAction {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}

export type MenuEntry = MenuAction | 'separator' | { heading: ReactNode } | null | false | undefined;

export function Menu({ trigger, items, align = 'end' }: { trigger: ReactNode; items: MenuEntry[]; align?: 'start' | 'end' }) {
  const entries = items.filter((item): item is Exclude<MenuEntry, null | false | undefined> => !!item);
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align={align} sideOffset={6} collisionPadding={8} className="z-[60] min-w-52 animate-pop-in rounded-xl border border-line bg-surface p-1.5 shadow-xl">
          {entries.map((item, index) => {
            if (item === 'separator') return <Dropdown.Separator key={index} className="my-1 h-px bg-line" />;
            if ('heading' in item) {
              return (
                <Dropdown.Label key={index} className="px-3 py-2 text-xs text-ink-soft">
                  {item.heading}
                </Dropdown.Label>
              );
            }
            return (
              <Dropdown.Item
                key={index}
                disabled={item.disabled}
                onSelect={item.onSelect}
                className={cn(
                  'flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-sunken',
                  item.danger ? 'text-bad' : 'text-ink',
                )}
              >
                {item.icon}
                {item.label}
              </Dropdown.Item>
            );
          })}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
