import { useEffect, useState } from 'react';

const DEFAULT_TICK_MS = 30_000;

/** Render sırasında saat okumadan "şimdi"yi verir; belirtilen aralıkla yenilenir. */
export function useNow(tickMs = DEFAULT_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(timer);
  }, [tickMs]);
  return now;
}
