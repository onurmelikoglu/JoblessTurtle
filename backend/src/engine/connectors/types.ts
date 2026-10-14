import { SourceConnector } from '@prisma/client';

export type ResponseState = 'ok' | 'not_modified' | 'not_found' | 'forbidden' | 'unauthorized' | 'rate_limited' | 'timeout' | 'error' | 'blocked';

export interface RawListing {
  externalId: string;
  title: string;
  url?: string | null;
  locationText?: string | null;
  description?: string | null;
  postedAt?: Date | null;
  updatedAt?: Date | null;
  validThrough?: Date | null;
  closedMarker?: boolean;
  applyUrl?: string | null;
  applyEmail?: string | null;
  requisitionId?: string | null;
  workMode?: 'onsite' | 'hybrid' | 'remote' | 'unknown';
  companyName?: string | null;
  companyDomain?: string | null;
  /** İlanın açık olduğu kaynağında doğrulanamadı (ör. sayfası okunamayan platform ilanı): durumu "teyit gerekli" olur. */
  unverified?: boolean;
}

export interface CollectResult {
  state: ResponseState;
  httpStatus?: number;
  /** Tüm sayfalar eksiksiz alındı mı? Eksik tarama kapanış kanıtı sayılmaz. */
  complete: boolean;
  listings: RawListing[];
  pages: number;
  sourceUrl: string;
  etag?: string | null;
  lastModified?: string | null;
  contentHash?: string | null;
  retryAfterSeconds?: number | null;
  error?: string | null;
  contacts?: { email: string; sourceUrl: string }[];
}

export type VerifyResult = 'open' | 'closed' | 'not_found' | 'unavailable';

export interface Connector {
  kind: string;
  label: string;
  extractorVersion: string;
  capabilities: string[];
  accessMode: 'api' | 'html' | 'manual';
  defaultIntervalMinutes: number;
  minIntervalMinutes: number;
  /** Başvuru kanalı: email ise e-posta ile başvuru desteklenir; platform ise kullanıcı platformda tamamlar. */
  applyChannel: 'email' | 'platform' | 'ats_form';
  isOfficial: boolean;
  /**
   * Toplayıcı kaynak (ilan sitesi, uzaktan çalışma panosu, web araması): birçok firmanın ilanını getirir. Yalnızca arama
   * profiline uyan ilanlar kaydedilir ve bu ilanlar resmî kaynakla doğrulanmadıkça otomatik başvuruya girmez.
   */
  aggregator?: boolean;
  collect(source: SourceConnector): Promise<CollectResult>;
  verify(source: SourceConnector, externalId: string, url?: string | null): Promise<VerifyResult>;
}
