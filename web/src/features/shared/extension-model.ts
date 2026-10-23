import type { ExtensionKeyStatus, ExtensionSearch, ScraperSource } from '@/api/types';

/** Eklentinin depodaki klasörü; Chrome'a "Paketlenmemiş öğe yükle" ile bu klasör seçilir. */
export const EXTENSION_FOLDER = 'browser-extension';

export const EXTENSION_STEPS = [
  'Chrome adres çubuğuna chrome://extensions yaz.',
  'Sağ üstten Geliştirici modu anahtarını aç.',
  `Paketlenmemiş öğe yükle düğmesine bas ve depodaki ${EXTENSION_FOLDER} klasörünü seç.`,
  'Eklentinin simgesine tıkla; açılan ayarlarda uygulama adresini (bu sayfanın adresi) ve aşağıda üreteceğin anahtarı gir, Kaydet ve dene.',
  "Kariyer.net ya da Indeed arama sonuç sayfasında sağ alttaki Jobless Turtle'a aktar düğmesini kullan.",
] as const;

export const SEARCH_SOURCES: { source: ScraperSource; button: string }[] = [
  { source: 'kariyer_net', button: "Kariyer.net'te ara" },
  { source: 'indeed', button: "Indeed'de ara" },
];

/** Menüde görünen ad: "İstanbul" ya da "Flutter Developer · İstanbul". */
export function searchLabel(search: Pick<ExtensionSearch, 'city' | 'keyword'>): string {
  return search.keyword ? `${search.keyword} · ${search.city}` : search.city;
}

export function searchesOf(searches: ExtensionSearch[] | undefined, source: ScraperSource): ExtensionSearch[] {
  return (searches ?? []).filter((s) => s.source === source);
}

/** Anahtarın durumu tek satırda: hiç kullanılmadıysa eklentinin henüz bağlanmadığı da söylenir. */
export function keySummary(status: ExtensionKeyStatus, fmt: (iso: string) => string): string {
  if (!status.exists || !status.created_at) return 'Henüz anahtar yok.';
  const used = status.last_used_at ? `son kullanım ${fmt(status.last_used_at)}` : 'eklenti henüz bu anahtarla bağlanmadı';
  return `Anahtar ${fmt(status.created_at)} üretildi; ${used}.`;
}
