import { SourceConnector } from '@prisma/client';
import { JOB_ALERT_SOURCE } from '../../domain/job-alerts';
import { WEB_SEARCH_SOURCE } from '../../domain/job-search';
import { WORKSPACE_SOURCE_KIND } from '../../domain/scraper-config';
import { CollectResult, Connector, VerifyResult } from './types';

/**
 * LinkedIn, Indeed, Glassdoor, Kariyer.net: bu bağlayıcılar kaynak kuyruğunda toplama yapmaz (oturum açan bot yok).
 * Kaynaklar kullanıcının girdiği kayıtlar, kendisine gelen uyarılar ve ilan sitesi taramasıyla (engine/scraper.service.ts,
 * yalnızca oturumsuz arama sayfaları) beslenir; başvuru "Platformda tamamla" ile kullanıcı tarafından yapılır.
 */
function manualConnector(kind: string, label: string, extra: Partial<Pick<Connector, 'applyChannel' | 'aggregator'>> = {}): Connector {
  return {
    kind,
    label,
    extractorVersion: 'manual@1',
    capabilities: ['manual_record'],
    accessMode: 'manual',
    defaultIntervalMinutes: 0,
    minIntervalMinutes: 0,
    applyChannel: 'platform',
    isOfficial: false,
    ...extra,
    async collect(source: SourceConnector): Promise<CollectResult> {
      return { state: 'ok', complete: false, listings: [], pages: 0, sourceUrl: `manual://${source.kind}` };
    },
    async verify(): Promise<VerifyResult> {
      return 'unavailable';
    },
  };
}

export const manualConnectors: Connector[] = [
  manualConnector('manual', 'Manuel kayıt'),
  manualConnector('linkedin', 'LinkedIn (manuel / uyarı kaydı)'),
  manualConnector('indeed', 'Indeed (manuel / uyarı kaydı)'),
  manualConnector('glassdoor', 'Glassdoor (manuel / uyarı kaydı)'),
  manualConnector('kariyernet', 'Kariyer.net (manuel / uyarı kaydı)'),
  // Web aramasında bulunan ilanlar (her platformdan): firmanın adresi biliniyorsa e-postayla da başvurulabilir.
  manualConnector(WEB_SEARCH_SOURCE, 'İlan araması (web)', { applyChannel: 'ats_form', aggregator: true }),
  // İş sitelerinin kullanıcıya postayla gönderdiği ilan bildirimleri (iş alarmı).
  manualConnector(JOB_ALERT_SOURCE, 'İş alarmı (mail)', { applyChannel: 'ats_form', aggregator: true }),
  // İlan sitelerinin herkese açık arama sayfalarının taraması (engine/scraper.service.ts); toplama worker'ın tarama kuyruğunda yapılır.
  manualConnector(WORKSPACE_SOURCE_KIND.kariyer_net, 'Kariyer.net taraması', { applyChannel: 'ats_form', aggregator: true }),
  manualConnector(WORKSPACE_SOURCE_KIND.indeed, 'Indeed taraması', { applyChannel: 'ats_form', aggregator: true }),
];
