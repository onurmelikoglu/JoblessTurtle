import type { IsoDate, JobAlertSearch, JobAlertSite } from '@/api/types';

export interface AlertSite {
  platform: string;
  /** Sitede alarm düğmesinin adı; kullanıcıya ne arayacağını söyler. */
  action: string;
  searchUrl: (search: JobAlertSearch) => string;
}

const query = (params: Record<string, string | null>) => new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();

/**
 * Alarm kurulabilecek siteler ve profildeki aramanın sitedeki arama adresi. Kullanıcı açılan sayfada kendi hesabıyla
 * alarmı kurar; uygulama siteye bağlanmaz. Kariyer.net'in şehir parametresi doğrulanamadığı için şehir orada seçilir.
 */
export const ALERT_SITES: AlertSite[] = [
  { platform: 'Kariyer.net', action: 'İş alarmı oluştur', searchUrl: (s) => `https://www.kariyer.net/is-ilanlari?${query({ kw: s.title })}` },
  { platform: 'LinkedIn', action: 'Uyarı oluştur', searchUrl: (s) => `https://www.linkedin.com/jobs/search/?${query({ keywords: s.title, location: s.city ? `${s.city}, Türkiye` : 'Türkiye' })}` },
  { platform: 'Indeed', action: 'İş ilanı uyarısı', searchUrl: (s) => `https://tr.indeed.com/jobs?${query({ q: s.title, l: s.city })}` },
];

export type AlertSiteState = { kind: 'working'; mails: number; lastAt: IsoDate | null } | { kind: 'none' };

export function alertSiteState(platform: string, sites: JobAlertSite[]): AlertSiteState {
  const site = sites.find((s) => s.platform === platform);
  return site && site.mails > 0 ? { kind: 'working', mails: site.mails, lastAt: site.lastAt } : { kind: 'none' };
}

export const searchLabel = (search: JobAlertSearch) => (search.city ? `${search.title} · ${search.city}` : search.title);
