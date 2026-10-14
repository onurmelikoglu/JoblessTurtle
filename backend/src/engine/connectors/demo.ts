import { SourceConnector } from '@prisma/client';
import { CollectResult, Connector, RawListing, VerifyResult } from './types';

/**
 * Demo kaynak: gerçek siteye istek atmadan ilan yaşam döngüsünü (yeni, kapanma, yeniden açılma,
 * erişim engeli) gösterir. Seed verisinde kullanılır; arayüzde "Demo" olarak etiketlenir.
 * config.listings: [{externalId,title,locationText,description,applyEmail,openFromRun?,closeAfterRun?,reopenAtRun?}]
 * config.run: çalıştırma sayacı (her collect'te artar)
 * config.blockAtRun: bu çalıştırmada 403 döner
 */
export interface DemoListing extends RawListing {
  openFromRun?: number;
  closeAfterRun?: number;
  reopenAtRun?: number;
}

export function demoSnapshot(listings: DemoListing[], run: number): RawListing[] {
  return listings
    .filter((l) => {
      if (l.openFromRun && run < l.openFromRun) return false;
      if (l.closeAfterRun && run > l.closeAfterRun && !(l.reopenAtRun && run >= l.reopenAtRun)) return false;
      return true;
    })
    .map(({ openFromRun: _a, closeAfterRun: _b, reopenAtRun: _c, ...rest }) => ({
      ...rest,
      postedAt: rest.postedAt ? new Date(rest.postedAt) : null,
      validThrough: rest.validThrough ? new Date(rest.validThrough) : null,
    }));
}

export const demoConnector: Connector = {
  kind: 'demo',
  label: 'Demo kaynak (çevrimdışı örnek)',
  extractorVersion: 'demo@1',
  capabilities: ['discover', 'detail', 'verify'],
  accessMode: 'api',
  defaultIntervalMinutes: 10,
  minIntervalMinutes: 1,
  applyChannel: 'email',
  isOfficial: true,
  async collect(source: SourceConnector): Promise<CollectResult> {
    const cfg = (source.config ?? {}) as { listings?: DemoListing[]; run?: number; blockAtRun?: number };
    const run = cfg.run ?? 1;
    const url = `demo://${source.id}`;
    if (cfg.blockAtRun && run === cfg.blockAtRun) {
      return { state: 'forbidden', httpStatus: 403, complete: false, listings: [], pages: 1, sourceUrl: url, error: 'Demo: erişim engeli simülasyonu' };
    }
    return { state: 'ok', httpStatus: 200, complete: true, listings: demoSnapshot(cfg.listings ?? [], run), pages: 1, sourceUrl: url };
  },
  async verify(source: SourceConnector, externalId: string): Promise<VerifyResult> {
    const cfg = (source.config ?? {}) as { listings?: DemoListing[]; run?: number };
    const present = demoSnapshot(cfg.listings ?? [], cfg.run ?? 1).some((l) => l.externalId === externalId);
    return present ? 'open' : 'not_found';
  },
};
