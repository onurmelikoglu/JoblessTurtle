import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { ConfirmContext, type ConfirmFn, type ConfirmOptions } from './confirm-context';
import { Dialog } from './Dialog';

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((next) => {
    resolver.current?.(false);
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOptions(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={options !== null}
        onClose={() => settle(false)}
        title={options?.title ?? ''}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => settle(false)}>
              Vazgeç
            </Button>
            <Button variant={options?.danger ? 'danger' : 'primary'} onClick={() => settle(true)} autoFocus>
              {options?.confirmLabel ?? 'Onayla'}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed whitespace-pre-line text-ink-soft">{options?.message}</p>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
