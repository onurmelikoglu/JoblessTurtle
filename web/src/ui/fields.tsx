import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const CONTROL = 'w-full rounded-lg border border-line-strong bg-surface text-sm text-ink placeholder:text-ink-faint transition-colors duration-150 hover:border-ink-faint disabled:opacity-60';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL, 'h-10 px-3', className)} {...rest} />;
}

export function Textarea({ className, rows = 6, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={rows} className={cn(CONTROL, 'min-h-24 resize-y px-3 py-2 leading-relaxed', className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(CONTROL, 'h-10 pr-8 pl-3', className)} {...rest} />;
}

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}

/** Etiket, yardım metni ve hata mesajını denetime bağlar; denetim render prop ile verilir. */
export function Field({ label, hint, error, className, children }: FieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-ink-soft">
        {label}
      </label>
      {children({ id, 'aria-describedby': note ? noteId : undefined, 'aria-invalid': error ? true : undefined })}
      {note && (
        <p id={noteId} className={cn('text-xs', error ? 'text-bad' : 'text-ink-soft')}>
          {note}
        </p>
      )}
    </div>
  );
}

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
}

export function Checkbox({ checked, onChange, label, className, disabled, ...rest }: CheckboxProps) {
  return (
    <label className={cn('inline-flex min-h-9 items-center gap-2 text-sm', disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer', className)}>
      <input type="checkbox" className="size-[18px] shrink-0 cursor-[inherit] rounded accent-brand" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} {...rest} />
      {label}
    </label>
  );
}

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  hideLabel?: boolean;
  description?: ReactNode;
}

export function Switch({ checked, onChange, label, disabled, hideLabel, description }: SwitchProps) {
  const id = useId();
  return (
    <div className="flex items-center gap-3">
      {!hideLabel && (
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="text-sm font-medium">
            {label}
          </label>
          {description && <p className="text-xs text-ink-soft">{description}</p>}
        </div>
      )}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={hideLabel ? label : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-50', checked ? 'bg-brand' : 'bg-line-strong')}
      >
        <span className={cn('absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200', checked && 'translate-x-5')} />
      </button>
    </div>
  );
}
