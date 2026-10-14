export const COMPANY_CLASSES = ['open', 'past', 'potential'] as const;
export type CompanyClass = (typeof COMPANY_CLASSES)[number];

export const COMPANY_CLASS_LABELS: Record<CompanyClass, string> = {
  open: 'Açık ilanı olan firmalar',
  past: 'Bu pozisyonu daha önce açmış firmalar',
  potential: 'Pozisyon açma potansiyeli olan firmalar',
};

const OPEN_CATEGORIES = new Set(['target_open', 'adjacent_open', 'user_selected']);
const POTENTIAL_CATEGORIES = new Set(['sector_target', 'not_found']);

/**
 * Fırsatın firma sınıfına katkısı. Teyit gereken kayıt bir ilana bağlıysa ilgili ilan vardır (açıklığı doğrulanamadı);
 * firmaya bağlıysa ilgili ilan hiç görülmemiştir. Listelenmeyen kategoriler (excluded vb.) null döner.
 */
export function classOfOpportunity(o: { category: string; jobId: string | null }): CompanyClass | null {
  if (OPEN_CATEGORIES.has(o.category)) return 'open';
  if (o.category === 'needs_confirmation') return o.jobId ? 'open' : 'potential';
  if (o.category === 'past_closed') return 'past';
  if (POTENTIAL_CATEGORIES.has(o.category)) return 'potential';
  return null;
}

/** Firma tek sınıfa düşer: açık ilan > geçmişte açmış > potansiyel. Görünür fırsatı olmayan firmanın sınıfı yoktur. */
export function classOfCompany(opportunities: { category: string; jobId: string | null }[]): CompanyClass | null {
  const classes = new Set(opportunities.map(classOfOpportunity));
  return COMPANY_CLASSES.find((c) => classes.has(c)) ?? null;
}
