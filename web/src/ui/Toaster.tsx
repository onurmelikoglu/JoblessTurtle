import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { cn } from '@/lib/cn';
import { currentToasts, dismissToast, subscribeToasts, type ToastTone } from './toast';

const TONE_STYLE: Record<ToastTone, string> = {
  success: 'border-good/30 bg-good-soft text-good',
  error: 'border-bad/30 bg-bad-soft text-bad',
  info: 'border-line-strong bg-surface text-ink',
  warn: 'border-warn/30 bg-warn-soft text-warn',
};
const TONE_ICON = { success: CircleCheck, error: CircleAlert, info: Info, warn: TriangleAlert };

export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, currentToasts);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[70] flex flex-col items-center gap-2 p-4 sm:items-end" aria-live="polite">
      {toasts.map((item) => {
        const Icon = TONE_ICON[item.tone];
        return (
          <div key={item.id} role={item.tone === 'error' ? 'alert' : 'status'} className={cn('pointer-events-auto flex w-full max-w-md animate-pop-in items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg', TONE_STYLE[item.tone])}>
            <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p className="min-w-0 flex-1 whitespace-pre-line break-words text-ink">{item.message}</p>
            <button type="button" onClick={() => dismissToast(item.id)} aria-label="Bildirimi kapat" className="-m-1 rounded p-1 text-ink-soft hover:text-ink">
              <X className="size-4" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
