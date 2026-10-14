import { appTarget } from './notification-links';

/**
 * İlk arayüz rotaları adresin "#" bölümünde taşıyordu; Telegram bildirimleri ve Gmail yetkilendirme dönüşü hâlâ bu
 * biçimde bağlantı üretir. Bağlantı, uygulama içi bildirimlerle aynı kurallarla yeni adresine gider.
 */
export function legacyTarget(hash: string): string | null {
  if (!hash.startsWith('#/')) return null;
  return appTarget(hash.slice(1));
}

export function redirectLegacyHash(location: Pick<Location, 'pathname' | 'hash' | 'replace'>): boolean {
  if (location.pathname !== '/') return false;
  const target = legacyTarget(location.hash);
  if (!target) return false;
  location.replace(target);
  return true;
}
