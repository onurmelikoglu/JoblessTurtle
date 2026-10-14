import { atsBoardLink, AtsKind } from './ats-detect';
import { connectorFor } from './registry';

export type DiscoveredSourceKind = AtsKind | 'career_page';

const SHORT_NAMES: Record<DiscoveredSourceKind, string> = {
  career_page: 'Kariyer sayfası',
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  workable: 'Workable',
  smartrecruiters: 'SmartRecruiters',
  recruitee: 'Recruitee',
  ashby: 'Ashby',
  teamtailor: 'Teamtailor',
  personio: 'Personio',
};
const CAREER_PAGE_EVIDENCE = 'Resmî site; robots.txt kontrol edilir';
const ATS_EVIDENCE = 'Kamuya açık ilan panosu';

/** Firmanın kendi resmî ilan kaynakları: kariyer sayfası ve başvuru (ATS) panoları. */
export const DISCOVERED_SOURCE_KINDS = Object.keys(SHORT_NAMES) as DiscoveredSourceKind[];

export function isDiscoveredSourceKind(kind: string): kind is DiscoveredSourceKind {
  return kind in SHORT_NAMES;
}

/** Keşif ya da ortak katalogdan gelen resmî kaynak için takip ayarları; aralıklar bağlayıcının varsayılanıdır. */
export function discoveredSourceData(kind: DiscoveredSourceKind, companyName: string, config: Record<string, string>) {
  const connector = connectorFor(kind);
  return {
    kind,
    name: `${companyName} — ${SHORT_NAMES[kind]}`,
    config,
    accessMode: connector.accessMode,
    capabilities: connector.capabilities,
    intervalMinutes: connector.defaultIntervalMinutes,
    minIntervalMinutes: connector.minIntervalMinutes,
    permissionEvidence: kind === 'career_page' ? CAREER_PAGE_EVIDENCE : ATS_EVIDENCE,
  };
}

/** Takip edilen kaynağın (kariyer sayfası, başvuru panosu) herkese açık bağlantısı. */
export function careersLinkOfSource(source: { kind: string; config: unknown }): string | null {
  if (source.kind === 'career_page') return ((source.config ?? {}) as { url?: string }).url ?? null;
  return atsBoardLink(source.kind, source.config);
}
