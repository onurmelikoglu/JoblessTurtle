import { ashbyConnector } from './ashby';
import { personioConnector } from './personio';
import { recruiteeConnector } from './recruitee';
import { smartRecruitersConnector } from './smartrecruiters';
import { teamtailorConnector } from './teamtailor';
import { Connector } from './types';
import { workableConnector } from './workable';

export type AtsKind = 'greenhouse' | 'lever' | 'workable' | 'smartrecruiters' | 'recruitee' | 'ashby' | 'teamtailor' | 'personio';

/** Greenhouse ve Lever dışındaki ATS bağlayıcıları; kayıt defterine topluca eklenir. */
export const ATS_CONNECTORS: Connector[] = [workableConnector, smartRecruitersConnector, recruiteeConnector, ashbyConnector, teamtailorConnector, personioConnector];

const GREENHOUSE_HOSTS = ['boards.greenhouse.io', 'job-boards.greenhouse.io'];
const GREENHOUSE_EMBED_SEGMENT = 'embed';
const GREENHOUSE_EMBED_PARAM = 'for';
const LEVER_HOST = 'jobs.lever.co';
const WORKABLE_HOST = 'apply.workable.com';
const WORKABLE_DOMAIN = 'workable.com';
const SMARTRECRUITERS_HOSTS = ['jobs.smartrecruiters.com', 'careers.smartrecruiters.com'];
const RECRUITEE_DOMAIN = 'recruitee.com';
const ASHBY_HOST = 'jobs.ashbyhq.com';
const TEAMTAILOR_DOMAIN = 'teamtailor.com';
const PERSONIO_HOST = /^[a-z0-9-]+\.jobs\.personio\.(de|com)$/;

/** Firma kısa adı olamayacak genel alt alan adları ve ATS'lerin kendi yol parçaları (ör. /embed, /j, /oneclick-ui). */
const GENERIC_SLUGS = new Set(['www', 'app', 'api', 'apply', 'jobs', 'careers', 'help', 'support', 'docs', 'blog', 'status', 'login', 'auth', 'cdn', 'static', 'assets', 'mail', 'embed', 'j', 'oneclick-ui', 'external-referrals']);
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
/** Ashby pano adları boşluk ve nokta içerebilir (ör. "Flock Safety"). */
const ASHBY_ORG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._&'-]*$/u;
const SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;

function parseLink(link: string): URL | null {
  if (typeof link !== 'string' || !link.trim()) return null;
  const raw = link.trim();
  try {
    const url = new URL(SCHEME_PREFIX.test(raw) ? raw : `https://${raw}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function firstSegment(url: URL): string | null {
  const segment = url.pathname.split('/').find(Boolean);
  if (!segment) return null;
  try {
    return decodeURIComponent(segment).trim() || null;
  } catch {
    return null;
  }
}

function slugOf(value: string | null | undefined, pattern: RegExp = SLUG_PATTERN): string | null {
  const slug = value?.trim();
  return slug && pattern.test(slug) && !GENERIC_SLUGS.has(slug.toLowerCase()) ? slug : null;
}

/** "acme.recruitee.com" → "acme"; alan adının kendisi, çok katmanlı ya da genel alt alan adları eşleşmez. */
function subdomainOf(host: string, domain: string): string | null {
  if (!host.endsWith(`.${domain}`)) return null;
  return slugOf(host.slice(0, -domain.length - 1), SUBDOMAIN_PATTERN);
}

function normalizeHost(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  return HOST_PATTERN.test(host) ? host : null;
}

/**
 * Bir pano ya da ilan bağlantısından ATS türünü ve bağlayıcının beklediği ayarı çıkarır.
 * Tanınmayan, bozuk ya da firma adı taşımayan bağlantılarda null döner; hata fırlatmaz.
 */
export function detectAtsSource(link: string): { kind: AtsKind; config: Record<string, string> } | null {
  const url = parseLink(link);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const segment = firstSegment(url);

  if (GREENHOUSE_HOSTS.includes(host)) {
    const token = slugOf(segment?.toLowerCase() === GREENHOUSE_EMBED_SEGMENT ? url.searchParams.get(GREENHOUSE_EMBED_PARAM) : segment);
    return token ? { kind: 'greenhouse', config: { boardToken: token.toLowerCase() } } : null;
  }
  if (host === LEVER_HOST) {
    const site = slugOf(segment);
    return site ? { kind: 'lever', config: { site: site.toLowerCase() } } : null;
  }
  if (host === WORKABLE_HOST) {
    const account = slugOf(segment);
    return account ? { kind: 'workable', config: { account: account.toLowerCase() } } : null;
  }
  const workableAccount = subdomainOf(host, WORKABLE_DOMAIN);
  if (workableAccount) return { kind: 'workable', config: { account: workableAccount } };
  if (SMARTRECRUITERS_HOSTS.includes(host)) {
    const company = slugOf(segment);
    return company ? { kind: 'smartrecruiters', config: { company } } : null;
  }
  const recruiteeCompany = subdomainOf(host, RECRUITEE_DOMAIN);
  if (recruiteeCompany) return { kind: 'recruitee', config: { company: recruiteeCompany } };
  if (host === ASHBY_HOST) {
    const org = slugOf(segment, ASHBY_ORG_PATTERN);
    return org ? { kind: 'ashby', config: { org } } : null;
  }
  if (host.endsWith(`.${TEAMTAILOR_DOMAIN}`)) return slugOf(host.split('.')[0], SUBDOMAIN_PATTERN) ? { kind: 'teamtailor', config: { host } } : null;
  if (PERSONIO_HOST.test(host)) return slugOf(host.split('.')[0], SUBDOMAIN_PATTERN) ? { kind: 'personio', config: { host } } : null;
  return null;
}

interface BoardLink {
  key: string;
  link(value: string): string | null;
}

const pathLink = (base: string) => (value: string) => `${base}/${encodeURIComponent(value)}`;
const hostLink = (suffix: string) => (value: string) => {
  const host = normalizeHost(value);
  return host ? `https://${host}${suffix}` : null;
};

const BOARD_LINKS = new Map<string, BoardLink>([
  ['greenhouse', { key: 'boardToken', link: pathLink(`https://${GREENHOUSE_HOSTS[0]}`) }],
  ['lever', { key: 'site', link: pathLink(`https://${LEVER_HOST}`) }],
  ['workable', { key: 'account', link: pathLink(`https://${WORKABLE_HOST}`) }],
  ['smartrecruiters', { key: 'company', link: pathLink(`https://${SMARTRECRUITERS_HOSTS[0]}`) }],
  ['recruitee', { key: 'company', link: (value) => (SUBDOMAIN_PATTERN.test(value.toLowerCase()) ? `https://${value.toLowerCase()}.${RECRUITEE_DOMAIN}` : null) }],
  ['ashby', { key: 'org', link: pathLink(`https://${ASHBY_HOST}`) }],
  ['teamtailor', { key: 'host', link: hostLink('/jobs') }],
  ['personio', { key: 'host', link: hostLink('') }],
]);

/** Kaynak türü ve ayarından kamuya açık pano adresi; tür bilinmiyorsa ya da ayar anahtarı eksik/geçersizse null. */
export function atsBoardLink(kind: string, config: unknown): string | null {
  const board = BOARD_LINKS.get(kind);
  if (!board || !config || typeof config !== 'object') return null;
  const value = (config as Record<string, unknown>)[board.key];
  return typeof value === 'string' && value.trim() ? board.link(value.trim()) : null;
}
