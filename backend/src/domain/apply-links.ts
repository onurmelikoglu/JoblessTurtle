export const APPLY_LINK_KINDS = ['form', 'linkedin', 'kariyernet', 'indeed', 'glassdoor', 'platform', 'reply', 'careers', 'website'] as const;
export type ApplyLinkKind = (typeof APPLY_LINK_KINDS)[number];

export interface ApplyLink {
  kind: ApplyLinkKind;
  label: string;
  url: string;
}

const PLATFORMS: { host: RegExp; kind: ApplyLinkKind; label: string }[] = [
  { host: /(^|\.)linkedin\.com$/, kind: 'linkedin', label: "LinkedIn'de başvur" },
  { host: /(^|\.)kariyer\.net$/, kind: 'kariyernet', label: "Kariyer.net'te başvur" },
  { host: /(^|\.)indeed\.com$/, kind: 'indeed', label: "Indeed'de başvur" },
  { host: /(^|\.)glassdoor\.(com|com\.tr)$/, kind: 'glassdoor', label: "Glassdoor'da başvur" },
  { host: /(^|\.)(youthall\.com|secretcv\.com|eleman\.net|yenibiris\.com|wellfound\.com|remoteok\.com|remotive\.com)$/, kind: 'platform', label: 'İlan sitesinde başvur' },
];
const FORM_CHANNELS = new Set(['ats_form', 'platform']);

/** Yalnızca http(s) bağlantıları kabul edilir; şeması yazılmamış adres https sayılır. Arayüzde href olacağı için başka şema geçmez. */
export function safeLinkUrl(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function linkKey(url: string) {
  return url.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
}

function platformOf(url: string) {
  const host = new URL(url).hostname.toLowerCase();
  return PLATFORMS.find((p) => p.host.test(host)) ?? null;
}

function dedupe(links: ApplyLink[]) {
  const seen = new Set<string>();
  return links.filter((l) => !seen.has(linkKey(l.url)) && seen.add(linkKey(l.url)));
}

/**
 * İlanın başvuru kanalları: ilanın kendi formu ve aynı ilanın farklı kaynaklardaki kopyaları ayrı buton olur.
 * Aynı sitedeki ilan ve "başvur" sayfası tek kanaldır; ilk görülen (başvuru adresi) kalır.
 */
export function jobApplyLinks(job: { applyUrl: string | null; channel: string; listings?: { applyUrl: string | null; canonicalUrl: string | null }[] }): ApplyLink[] {
  const urls = [job.applyUrl, ...(job.listings ?? []).flatMap((l) => [l.applyUrl, l.canonicalUrl])].map(safeLinkUrl).filter((u): u is string => !!u);
  const hosts = new Set<string>();
  const links: ApplyLink[] = [];
  for (const url of urls) {
    const host = new URL(url).hostname.toLowerCase();
    if (hosts.has(host)) continue;
    hosts.add(host);
    const platform = platformOf(url);
    links.push(platform ? { kind: platform.kind, label: platform.label, url } : { kind: 'form', label: FORM_CHANNELS.has(job.channel) ? 'Başvuru formunu aç' : 'İlanı aç', url });
  }
  return links;
}

export function companyLinks(company: { careersUrl: string | null; website: string | null }): ApplyLink[] {
  const careers = safeLinkUrl(company.careersUrl);
  const website = safeLinkUrl(company.website);
  return dedupe([...(careers ? [{ kind: 'careers' as const, label: 'Kariyer sayfası', url: careers }] : []), ...(website ? [{ kind: 'website' as const, label: 'Firma sitesi', url: website }] : [])]);
}

/** Firmanın mail yanıtında "buradan başvurun" diye verdiği bağlantı. */
export function replyApplyLink(url: string | null | undefined): ApplyLink | null {
  const safe = safeLinkUrl(url);
  return safe ? { kind: 'reply', label: 'Firmanın istediği başvuru sayfası', url: safe } : null;
}

export function mergeLinks(...groups: (ApplyLink | null)[][]): ApplyLink[] {
  return dedupe(groups.flat().filter((l): l is ApplyLink => !!l));
}
