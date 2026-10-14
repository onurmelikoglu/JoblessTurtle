import type { IsoDate, JobAlertSite } from '@/api/types';

/** Sitede açılacak arama: seçilen pozisyonlar ve şehir (null: Türkiye geneli). */
export interface AlertQuery {
  titles: string[];
  city: string | null;
}

export interface AlertSite {
  platform: string;
  /** Butonun adı, Türkçe ek ile ("Kariyer.net'te aç"). */
  openLabel: string;
  /** Sitede alarm düğmesinin adı; kullanıcıya ne arayacağını söyler. */
  action: string;
  /** Arama "VEYA" ile birden çok pozisyonu tek alarmda birleştirebiliyor mu? */
  supportsOr: boolean;
  searchUrl: (query: AlertQuery) => string;
}

const params = (entries: Record<string, string | null>) => new URLSearchParams(Object.entries(entries).filter((e): e is [string, string] => !!e[1])).toString();

/** Birden çok pozisyon tek aramada birleşir: çok kelimeli unvan tırnak içinde, aralarında OR. */
export function orKeywords(titles: string[]): string {
  if (titles.length === 1) return titles[0];
  return titles.map((title) => (/\s/.test(title) ? `"${title}"` : title)).join(' OR ');
}

/**
 * Alarm kurulabilecek siteler ve seçilen aramanın sitedeki adresi. Kullanıcı açılan sayfada kendi hesabıyla alarmı kurar;
 * uygulama siteye bağlanmaz. Kariyer.net "VEYA" aramasını ve şehir parametresini desteklemediği için orada tek pozisyonla
 * açılır, şehir sayfadan seçilir.
 */
export const ALERT_SITES: AlertSite[] = [
  { platform: 'Kariyer.net', openLabel: "Kariyer.net'te aç", action: 'İş alarmı oluştur', supportsOr: false, searchUrl: (q) => `https://www.kariyer.net/is-ilanlari?${params({ kw: q.titles[0] })}` },
  { platform: 'LinkedIn', openLabel: "LinkedIn'de aç", action: 'Uyarı oluştur', supportsOr: true, searchUrl: (q) => `https://www.linkedin.com/jobs/search/?${params({ keywords: orKeywords(q.titles), location: q.city ? `${q.city}, Türkiye` : 'Türkiye' })}` },
  { platform: 'Indeed', openLabel: "Indeed'de aç", action: 'İş ilanı uyarısı', supportsOr: true, searchUrl: (q) => `https://tr.indeed.com/jobs?${params({ q: orKeywords(q.titles), l: q.city })}` },
];

export type AlertSiteState = { kind: 'working'; mails: number; lastAt: IsoDate | null } | { kind: 'none' };

export function alertSiteState(platform: string, sites: JobAlertSite[]): AlertSiteState {
  const site = sites.find((s) => s.platform === platform);
  return site && site.mails > 0 ? { kind: 'working', mails: site.mails, lastAt: site.lastAt } : { kind: 'none' };
}

/** Seçili pozisyonlar listede yoksa (profil değişti) ilk pozisyon seçilir; sıra profildeki sırayı izler. */
export function chosenTitles(titles: string[], selected: ReadonlySet<string>): string[] {
  const chosen = titles.filter((title) => selected.has(title));
  return chosen.length ? chosen : titles.slice(0, 1);
}

/** Pozisyonu seçime ekler ya da çıkarır; son kalan pozisyon çıkarılamaz (arama boş kalmasın). */
export function toggled(selected: ReadonlySet<string>, title: string): Set<string> {
  const next = new Set(selected);
  if (!next.has(title)) next.add(title);
  else if (next.size > 1) next.delete(title);
  return next;
}
