import { CircleAlert, RefreshCw } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { errorText } from '@/api/client';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/Button';
import { InlineBusy } from '@/ui/feedback';
import { Field, Select, Textarea } from '@/ui/fields';
import { Notice } from '@/ui/Notice';
import { Panel, PanelTitle } from '@/ui/Panel';

const SUB_TITLE = 'text-sm font-semibold';
const SUB_NOTE = 'text-sm text-ink-soft';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel className="flex flex-col gap-4">
      <PanelTitle>{title}</PanelTitle>
      {children}
    </Panel>
  );
}

export function SubSection({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className={cn('min-w-0 flex-1', SUB_TITLE)}>{title}</h3>
        {action}
      </div>
      {description && <p className={SUB_NOTE}>{description}</p>}
      {children}
    </div>
  );
}

export function Divider() {
  return <hr className="border-line" />;
}

interface ListRowProps {
  as?: 'div' | 'li';
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
}

export function ListRow({ as: Tag = 'div', leading, title, subtitle, trailing }: ListRowProps) {
  return (
    <Tag className="flex items-center gap-3 py-2">
      {leading}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium break-words">{title}</p>
        {subtitle && <p className="text-sm break-words text-ink-soft">{subtitle}</p>}
      </div>
      {trailing}
    </Tag>
  );
}

interface HeadedTextareaProps {
  title: string;
  description: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}

/** Başlık ve açıklama alanın etiketi olarak bağlanır; ayrı bir etiket satırı aynı metni yinelerdi. */
export function HeadedTextarea({ title, description, placeholder, value, onChange, rows = 6 }: HeadedTextareaProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const noteId = `${id}-note`;
  return (
    <div className="flex flex-col gap-2">
      <h3 id={titleId} className={SUB_TITLE}>
        {title}
      </h3>
      <p id={noteId} className={SUB_NOTE}>
        {description}
      </p>
      <Textarea aria-labelledby={titleId} aria-describedby={noteId} rows={rows} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} className="field-sizing-content max-h-[32rem]" />
    </div>
  );
}

interface LimitFieldProps {
  label: string;
  hint: string;
  value: number | null | undefined;
  options: readonly number[];
  disabled?: boolean;
  onChange: (value: number) => void;
}

/** Kayıtlı değer seçenekler arasında değilse yine de görünür; yalnızca listedeki değerler seçilebilir. */
export function LimitField({ label, hint, value, options, disabled, onChange }: LimitFieldProps) {
  const listed = value != null && options.includes(value) ? value : null;
  return (
    <Field label={label} hint={hint}>
      {(props) => (
        <div className="w-28">
          <Select {...props} disabled={disabled} value={listed ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
            {listed === null && (
              <option value="" disabled hidden>
                {value ?? '-'}
              </option>
            )}
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </div>
      )}
    </Field>
  );
}

export function QueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Notice
      tone="error"
      icon={<CircleAlert className="size-5 shrink-0" aria-hidden />}
      action={
        <Button size="sm" icon={<RefreshCw className="size-4" aria-hidden />} onClick={onRetry}>
          Tekrar dene
        </Button>
      }
    >
      {errorText(error)}
    </Notice>
  );
}

interface Loadable<T> {
  data: T | undefined;
  error: unknown;
  isError: boolean;
  refetch: () => unknown;
}

export function Loaded<T>({ query, children }: { query: Loadable<T>; children: (data: T) => ReactNode }) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isError) return <QueryError error={query.error} onRetry={() => void query.refetch()} />;
  return <InlineBusy>Yükleniyor…</InlineBusy>;
}
