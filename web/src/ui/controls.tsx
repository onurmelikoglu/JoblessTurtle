import { Search, X } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface FilterChipProps {
  active: boolean;
  onToggle: () => void;
  children: ReactNode;
  count?: number;
  icon?: ReactNode;
  title?: string;
}

export function FilterChip({ active, onToggle, children, count, icon, title }: FilterChipProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onToggle}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap transition-colors duration-150',
        active ? 'border-brand bg-brand-soft text-brand-strong' : 'border-line-strong bg-surface text-ink-soft hover:bg-sunken hover:text-ink',
      )}
    >
      {icon}
      {children}
      {count !== undefined && <span className={cn('tabular-nums', active ? 'text-brand-strong/80' : 'text-ink-faint')}>{count}</span>}
    </button>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (value: T) => void; options: SegmentOption<T>[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 rounded-xl border border-line bg-sunken p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'flex h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-1.5 text-[13px] font-medium transition-colors duration-150 sm:gap-2 sm:px-2 sm:text-sm',
            value === option.value ? 'bg-surface text-ink shadow-sm' : 'text-ink-soft hover:text-ink',
          )}
        >
          {option.icon}
          <span className="truncate">{option.label}</span>
          {option.badge}
        </button>
      ))}
    </div>
  );
}

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  onSubmit?: () => void;
  /** "/" tuşuyla odaklanır (bir metin alanında yazılmıyorken). */
  shortcut?: boolean;
  className?: string;
}

export function SearchInput({ value, onChange, placeholder, label, onSubmit, shortcut = false, className }: SearchInputProps) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!shortcut) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]');
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') onSubmit?.();
    if (event.key === 'Escape' && value) {
      event.stopPropagation();
      onChange('');
    }
  };

  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" aria-hidden />
      <input
        ref={ref}
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        value={value}
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="h-10 w-full rounded-lg border border-line-strong bg-surface pr-9 pl-9 text-sm text-ink placeholder:text-ink-faint hover:border-ink-faint [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button type="button" aria-label="Aramayı temizle" onClick={() => onChange('')} className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1.5 text-ink-soft hover:bg-sunken hover:text-ink">
          <X className="size-4" aria-hidden />
        </button>
      ) : (
        shortcut && <kbd className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 rounded border border-line bg-sunken px-1.5 text-[11px] text-ink-faint sm:block">/</kbd>
      )}
    </div>
  );
}
