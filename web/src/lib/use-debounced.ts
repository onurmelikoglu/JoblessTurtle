import { useEffect, useState } from 'react';

/** Değer belirtilen süre boyunca değişmeden kalınca güncellenen kopyası; yazdıkça arama için. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
