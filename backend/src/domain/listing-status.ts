/**
 * İlan durum kuralları — doküman §4.
 * - Açık "kapalı" ibaresi ve süresi geçmiş validThrough güçlü kapanış sinyalidir.
 * - Tek bir 404 veya listede bir kez kaybolma önce teyit gerektirir.
 * - Başarılı ve eksiksiz ATS listelemesinde ardışık yokluk + detay kontrolü birlikte kapanış üretebilir.
 * - 403, 429, timeout ve eksik sayfalama kapanış kanıtı olamaz.
 */

export type ListingStatus = 'open' | 'closed' | 'unknown' | 'stale';

export interface ListingState {
  status: ListingStatus;
  missingCount: number;
  openCycle: number;
  statusReason?: string | null;
}

export type Observation =
  | { kind: 'present'; closedMarker?: boolean; validThrough?: Date | null; now: Date }
  | { kind: 'absent'; crawlComplete: boolean; detail?: 'not_found' | 'closed' | 'open' | 'unavailable' }
  | { kind: 'fetch_failed'; reason: 'forbidden' | 'rate_limited' | 'timeout' | 'error' | 'partial' | 'blocked' };

export interface Transition extends ListingState {
  changed: boolean;
  reopened: boolean;
  closedNow: boolean;
}

export const MISSING_THRESHOLD = 2;

/**
 * Kaynağında doğrulanamayan bildirim (ör. sayfası okunamayan platform ilanı) ilanı açık saymaz: yeni kayıt "teyit
 * gerekli" olur, daha önce doğrulanmış açık ilan açık kalır, kapanmış ilan yeniden açılmaz.
 */
export function reportedStatus(observed: ListingStatus, previous?: ListingStatus): ListingStatus {
  if (observed === 'closed' || previous === 'closed') return 'closed';
  return previous === 'open' ? 'open' : 'unknown';
}

export function nextListingState(prev: ListingState, obs: Observation): Transition {
  const base = { ...prev, changed: false, reopened: false, closedNow: false };
  switch (obs.kind) {
    case 'fetch_failed':
      // Erişim hatası: durum değişmez, sadece kaynak sağlığı etkilenir.
      return base;
    case 'present': {
      const expired = obs.validThrough ? obs.validThrough.getTime() < obs.now.getTime() : false;
      if (obs.closedMarker || expired) {
        const reason = obs.closedMarker ? 'closed_marker' : 'valid_through_expired';
        return {
          ...prev,
          status: 'closed',
          missingCount: 0,
          statusReason: reason,
          changed: prev.status !== 'closed',
          reopened: false,
          closedNow: prev.status !== 'closed',
        };
      }
      const reopened = prev.status === 'closed';
      return {
        status: 'open',
        missingCount: 0,
        openCycle: reopened ? prev.openCycle + 1 : prev.openCycle,
        statusReason: reopened ? 'reopened' : 'seen_in_listing',
        changed: prev.status !== 'open',
        reopened,
        closedNow: false,
      };
    }
    case 'absent': {
      if (!obs.crawlComplete) return base; // eksik tarama kanıt değildir
      if (prev.status === 'closed') return base;
      const missing = prev.missingCount + 1;
      if (obs.detail === 'closed') {
        return { ...prev, status: 'closed', missingCount: missing, statusReason: 'detail_closed', changed: true, reopened: false, closedNow: true };
      }
      if (missing >= MISSING_THRESHOLD && obs.detail === 'not_found') {
        return {
          ...prev,
          status: 'closed',
          missingCount: missing,
          statusReason: 'missing_and_detail_404',
          changed: true,
          reopened: false,
          closedNow: true,
        };
      }
      if (obs.detail === 'open') {
        return { ...prev, status: 'open', missingCount: missing, statusReason: 'detail_open_missing_in_list', changed: prev.status !== 'open', reopened: false, closedNow: false };
      }
      if (missing >= MISSING_THRESHOLD) {
        return { ...prev, status: 'unknown', missingCount: missing, statusReason: 'missing_needs_confirmation', changed: prev.status !== 'unknown', reopened: false, closedNow: false };
      }
      return { ...prev, missingCount: missing, statusReason: 'missing_once', changed: false, reopened: false, closedNow: false };
    }
  }
}

/** Son doğrulamadan bu yana çok zaman geçmişse ilan "stale" kabul edilir. */
export function applyStaleness(status: ListingStatus, lastVerifiedAt: Date | null, now: Date, staleHours = 72): ListingStatus {
  if (status !== 'open') return status;
  if (!lastVerifiedAt) return 'unknown';
  return now.getTime() - lastVerifiedAt.getTime() > staleHours * 3600_000 ? 'stale' : status;
}

export interface ListingForMerge {
  isOfficial: boolean;
  status: ListingStatus;
  lastVerifiedAt: Date | null;
  sourceHealthy: boolean;
}

/**
 * Kanonik iş durumunu listelerden birleştirir. Resmî işveren/ATS kanıtı önceliklidir;
 * toplayıcıdaki "açık" kaydı kapalı resmî ilanı yeniden açamaz — çelişki saklanır.
 */
export function mergeJobStatus(listings: ListingForMerge[]): { status: ListingStatus; conflict: string | null } {
  if (listings.length === 0) return { status: 'unknown', conflict: null };
  const official = listings.filter((l) => l.isOfficial);
  const others = listings.filter((l) => !l.isOfficial);
  const pool = official.length > 0 ? official : others;
  let status: ListingStatus;
  if (pool.some((l) => l.status === 'open' && l.sourceHealthy)) status = 'open';
  else if (pool.some((l) => l.status === 'closed')) status = 'closed';
  else if (pool.some((l) => l.status === 'stale')) status = 'stale';
  else status = pool.some((l) => l.status === 'open') ? 'unknown' : 'unknown';
  let conflict: string | null = null;
  if (official.length > 0 && status === 'closed' && others.some((l) => l.status === 'open')) {
    conflict = 'Resmî kaynak kapalı, ikincil kaynakta açık görünüyor';
  }
  if (official.some((l) => l.status === 'open') && official.some((l) => l.status === 'closed')) {
    conflict = 'Resmî kaynaklar arasında çelişki';
  }
  return { status, conflict };
}
