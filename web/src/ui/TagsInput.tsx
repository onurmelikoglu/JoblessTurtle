import { X } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';

interface TagsInputProps {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  hint?: string;
  placeholder?: string;
  /** Verilirse yalnızca bu seçenekler eklenebilir ve yazarken önerilir. */
  options?: readonly string[];
}

const SEPARATORS = /[,;\n]+/;

export function TagsInput({ label, values, onChange, hint, placeholder = 'Yazıp Enter\'a bas', options }: TagsInputProps) {
  const id = useId();
  const [text, setText] = useState('');

  const add = (raw: string) => {
    const candidates = raw.split(SEPARATORS).map((part) => part.trim()).filter(Boolean);
    const allowed = options ? candidates.map((c) => options.find((o) => o.toLocaleLowerCase('tr') === c.toLocaleLowerCase('tr'))).filter((o): o is string => !!o) : candidates;
    const existing = new Set(values.map((v) => v.toLocaleLowerCase('tr')));
    const fresh = allowed.filter((c) => !existing.has(c.toLocaleLowerCase('tr')) && existing.add(c.toLocaleLowerCase('tr')));
    if (fresh.length) onChange([...values, ...fresh]);
    if (fresh.length || !options) setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      if (!text.trim()) return;
      event.preventDefault();
      add(text);
    } else if (event.key === 'Backspace' && !text && values.length) {
      onChange(values.slice(0, -1));
    }
  };

  const onInput = (next: string) => {
    if (options?.includes(next)) add(next);
    else if (SEPARATORS.test(next)) add(next);
    else setText(next);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink-soft">
        {label}
      </label>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2 py-1.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand hover:border-ink-faint">
        {values.map((value) => (
          <span key={value} className="inline-flex items-center gap-1 rounded-full bg-brand-soft py-0.5 pr-1 pl-2.5 text-[13px] text-brand-strong">
            {value}
            <button type="button" aria-label={`${value} kaldır`} onClick={() => onChange(values.filter((v) => v !== value))} className="rounded-full p-0.5 hover:bg-brand/20">
              <X className="size-3.5" aria-hidden />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={text}
          list={options ? `${id}-options` : undefined}
          placeholder={values.length ? '' : placeholder}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => text.trim() && add(text)}
          className="h-7 min-w-32 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-ink-faint"
        />
        {options && (
          <datalist id={`${id}-options`}>
            {options.filter((o) => !values.includes(o)).map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        )}
      </div>
      {hint && <p className="text-xs text-ink-soft">{hint}</p>}
    </div>
  );
}
