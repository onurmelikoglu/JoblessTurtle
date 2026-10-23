import { FilterX } from 'lucide-react';
import { Button } from '@/ui/Button';
import { FilterChip, SearchInput } from '@/ui/controls';
import { Checkbox, Field, Input } from '@/ui/fields';
import { Panel } from '@/ui/Panel';
import { hasActiveFilters, RANGE_PRESETS, rangeError, togglePreset, type NotificationFilters } from './notifications-model';

interface NotificationFilterBarProps {
  filters: NotificationFilters;
  onChange: (patch: Partial<NotificationFilters>) => void;
  onReset: () => void;
}

/** Metin araması, tarih-saat aralığı (elle ya da hazır aralıklardan) ve okunmamış süzgeci. */
export function NotificationFilterBar({ filters, onChange, onReset }: NotificationFilterBarProps) {
  const error = rangeError(filters);

  return (
    <Panel className="flex flex-col gap-3">
      <SearchInput shortcut value={filters.query} onChange={(query) => onChange({ query })} label="Bildirimlerde ara" placeholder="Başlık ya da içerikte ara" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Başlangıç" error={error}>
          {(props) => <Input {...props} type="datetime-local" value={filters.from} max={filters.to || undefined} onChange={(e) => onChange({ from: e.target.value, preset: null })} />}
        </Field>
        <Field label="Bitiş">{(props) => <Input {...props} type="datetime-local" value={filters.to} min={filters.from || undefined} onChange={(e) => onChange({ to: e.target.value, preset: null })} />}</Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Hazır tarih aralıkları">
          {RANGE_PRESETS.map((preset) => (
            <FilterChip key={preset.key} active={filters.preset === preset.key} onToggle={() => onChange(togglePreset(filters.preset, preset.key))}>
              {preset.label}
            </FilterChip>
          ))}
        </div>
        <Checkbox className="mr-auto" checked={filters.unread} onChange={(unread) => onChange({ unread })} label="Yalnızca okunmamışlar" />
        {hasActiveFilters(filters) && (
          <Button variant="ghost" size="sm" icon={<FilterX className="size-4" aria-hidden />} onClick={onReset}>
            Filtreyi temizle
          </Button>
        )}
      </div>
    </Panel>
  );
}
