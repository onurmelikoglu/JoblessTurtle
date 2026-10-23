import type { ExtensionKeyStatus, ExtensionSearch, ScraperSource } from '@/api/types';

/** Web imajının sunduğu eklenti paketi (web/Dockerfile); zipten çıkan klasör Chrome'a "Paketlenmemiş öğe yükle" ile seçilir. */
export const EXTENSION_DOWNLOAD = '/downloads/jobless-turtle-extension.zip';

export const EXTENSION_STEPS = [
  'Eklentiyi indir düğmesiyle zip dosyasını indir ve bir klasöre aç.',
  'Chrome adres çubuğuna chrome://extensions yaz, sağ üstten Geliştirici modu anahtarını aç.',
  'Paketlenmemiş öğe yükle düğmesine bas ve zipten çıkan klasörü seç. Eklentinin ayarları kendiliğinden açılır.',
  'Aşağıdan eşleştirme kodu üret, kopyala ve eklenti ayarlarındaki Eşleştirme kodu alanına yapıştır; Kaydet ve dene. Chrome bu adrese erişim izni ister.',
  "Kariyer.net, Indeed, Eleman.net, İşin Olsun, Secretcv ya da Yenibiriş arama sonuç sayfasında sağ alttaki Jobless Turtle'a aktar düğmesini kullan.",
] as const;

/**
 * Eklentinin ayarlarına tek seferde yapıştırılan kod: "jt1." + base64url(JSON {u: uygulama adresi, k: anahtar}).
 * Eklentideki options.js aynı biçimi çözer.
 */
export function pairingCode(appUrl: string, key: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ u: appUrl, k: key }));
  const base64 = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
  return `jt1.${base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export const SEARCH_SOURCES: { source: ScraperSource; button: string }[] = [
  { source: 'kariyer_net', button: "Kariyer.net'te ara" },
  { source: 'indeed', button: "Indeed'de ara" },
  { source: 'eleman_net', button: "Eleman.net'te ara" },
  { source: 'isinolsun', button: "İşin Olsun'da ara" },
  { source: 'secretcv', button: "Secretcv'de ara" },
  { source: 'yenibiris', button: "Yenibiriş'te ara" },
];

/**
 * Menüde görünen ad: "Flutter Developer · İstanbul, Kocaeli", "Flutter Developer / Mobile Developer · İstanbul",
 * ülke geneli aramada "Flutter Developer · Türkiye geneli", pozisyonsuz şehir sayfasında yalnızca şehir.
 */
export function searchLabel(search: Pick<ExtensionSearch, 'cities' | 'keywords'>): string {
  const place = search.cities.length ? search.cities.join(', ') : 'Türkiye geneli';
  return search.keywords.length ? `${search.keywords.join(' / ')} · ${place}` : place;
}

export function searchesOf(searches: ExtensionSearch[] | undefined, source: ScraperSource): ExtensionSearch[] {
  return (searches ?? []).filter((s) => s.source === source);
}

/** Eklentinin tek seferde açtığı en çok sekme (eklentideki MAX_OPEN_TABS ile aynı). */
export const MAX_OPEN_TABS = 20;

/**
 * "Hepsini aç": bütün sitelerin aramaları, tekrarsız, eklentinin açabileceği kadar. Siteler sırayla dönülür (her
 * siteden birinci arama, sonra ikinciler…); sınır aşılırsa ilk sitenin aramaları ötekileri dışarıda bırakmaz.
 */
export function openAllUrls(searches: ExtensionSearch[] | undefined): string[] {
  const bySource = new Map<string, string[]>();
  for (const s of searches ?? []) bySource.set(s.source, [...(bySource.get(s.source) ?? []), s.url]);
  const queues = [...bySource.values()];
  const urls: string[] = [];
  for (let i = 0; queues.some((q) => i < q.length); i++) for (const q of queues) if (i < q.length) urls.push(q[i]);
  return [...new Set(urls)].slice(0, MAX_OPEN_TABS);
}

/** Uygulama sayfasında eklentinin köprüsü çalışıyorsa sürümü (app-bridge.js işaretler), yoksa null. */
export function extensionVersion(root: HTMLElement = document.documentElement): string | null {
  return root.dataset.jtExtension ?? null;
}

/** Anahtarın durumu tek satırda: hiç kullanılmadıysa eklentinin henüz bağlanmadığı da söylenir. */
export function keySummary(status: ExtensionKeyStatus, fmt: (iso: string) => string): string {
  if (!status.exists || !status.created_at) return 'Henüz anahtar yok.';
  const used = status.last_used_at ? `son kullanım ${fmt(status.last_used_at)}` : 'eklenti henüz bu anahtarla bağlanmadı';
  return `Anahtar ${fmt(status.created_at)} üretildi; ${used}.`;
}
