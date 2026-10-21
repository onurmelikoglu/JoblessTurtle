export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bekleme süresine eklenen rastgele pay (en çok %25): istekler sabit aralıklı bir desen oluşturmasın. */
const JITTER_SHARE = 0.25;

/**
 * Site başına istek aralığı: iki isteğin başlangıcı arasında en az minIntervalMs (+ rastgele pay) geçer. Eşzamanlı
 * çalışan aramalar aynı sınırlayıcıyı paylaşır; böylece eşzamanlılık toplam istek hızını artırmaz.
 */
export class RateLimiter {
  private nextAt = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly sleep: Sleep = realSleep,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  async wait(): Promise<void> {
    const now = this.now();
    const startAt = Math.max(now, this.nextAt);
    this.nextAt = startAt + Math.round(this.minIntervalMs * (1 + JITTER_SHARE * this.random()));
    if (startAt > now) await this.sleep(startAt - now);
  }
}

/** Öğeleri en çok `concurrency` eşzamanlı işle çalıştırır; stopped() doğru dönünce yeni öğe başlatılmaz. */
export async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>, stopped: () => boolean = () => false): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (!stopped() && next < items.length) await fn(items[next++]);
  });
  await Promise.all(lanes);
}
