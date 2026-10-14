import { Injectable, Logger } from '@nestjs/common';
import { MailAccount, Prisma, SearchProfile } from '@prisma/client';
import * as cheerio from 'cheerio';
import { env } from '../common/env';
import { errorMessage } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { JobAlertStats } from '../contracts/home';
import { ServerShape } from '../contracts/wire';
import { htmlToText } from '../domain/inbound';
import { AlertLink, AlertListing, alertCities, alertLinks, alertPlatformOf, alertSearches, isListingUrl, JOB_ALERT_SOURCE, linkedListings, looksLikeAlert } from '../domain/job-alerts';
import { resolveRedirects } from '../domain/ssrf';
import { AiService } from './ai/ai.service';
import { ALERT_TEXT_LIMIT } from './ai/prompts';
import { FoundListing, JobSearchService } from './job-search.service';
import { LearningService } from './learning.service';
import { FetchedMail } from './mail/inbox';

const STATS_KEY = (workspaceId: string) => `jobalert:stats:${workspaceId}`;
const PENDING_KEY = (accountId: string) => `jobalert:pending:${accountId}`;
/** Yapay zekâ kullanılamadığı için bekleyen bildirim sayısı sınırı; fazlası (en eskiler) düşer. */
const MAX_PENDING = 20;
/** Tarama on dakikada bir çalışır; bildirim yaklaşık iki gün denendikten sonra bırakılır. */
const MAX_PENDING_TRIES = 300;
const latest = (current: string | null | undefined, next: string) => (!current || next > current ? next : current);
const TEXT_URL = /https?:\/\/[^\s<>"')\]]+/gi;

interface PreparedAlert {
  platform: string;
  subject: string;
  text: string;
  links: AlertLink[];
  receivedAt: string;
  tries?: number;
}

interface StoredStats {
  mails: number;
  listings: number;
  lastAt: string | null;
  platforms: Record<string, number>;
  lastByPlatform?: Record<string, string>;
}

/**
 * İş sitelerinin kullanıcıya gönderdiği ilan bildirimlerini (iş alarmı) ilana çevirir. Posta saklanmaz: bağlantıları ve
 * metni çıkarılır, ilanlar yapay zekâyla okunur, arama profiline uyanlar "iş alarmı" kaynağına açık ilan olarak yazılır.
 */
@Injectable()
export class JobAlertsService {
  private readonly logger = new Logger('JobAlerts');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly jobSearch: JobSearchService,
    private readonly learning: LearningService,
  ) {}

  fromJobSite(mail: { fromEmail: string | null }): boolean {
    return alertPlatformOf(mail.fromEmail) !== null;
  }

  /** İş sitesinden gelen postayı işler; ilan bildirimi değilse (hesap, başvuru onayı) dokunmaz. */
  async ingest(account: Pick<MailAccount, 'id' | 'workspaceId' | 'candidateId'>, mail: FetchedMail) {
    const platform = alertPlatformOf(mail.fromEmail);
    if (!platform) return { status: 'not_job_site' as const, fresh: 0 };
    const { links, text } = readAlert(mail);
    if (!looksLikeAlert({ subject: mail.subject, listingLinks: links.filter((l) => isListingUrl(l.url)).length }) || !links.length) return { status: 'not_alert' as const, fresh: 0 };
    return this.process(account, { platform, subject: mail.subject.slice(0, 300), text, links, receivedAt: mail.date.toISOString() });
  }

  /** Daha önce yapay zekâ kullanılamadığı için bekleyen bildirimleri yeniden dener. */
  async retryPending(account: Pick<MailAccount, 'id' | 'workspaceId' | 'candidateId'>) {
    const pending = await this.pending(account.id);
    if (!pending.length) return { retried: 0 };
    await this.prisma.keyValue.deleteMany({ where: { key: PENDING_KEY(account.id) } });
    for (const alert of pending) await this.process(account, alert);
    return { retried: pending.length };
  }

  private async process(account: Pick<MailAccount, 'id' | 'workspaceId' | 'candidateId'>, alert: PreparedAlert) {
    const profile = await this.profileOf(account);
    if (!profile) return { status: 'no_profile' as const, fresh: 0 };
    const r = await this.ai
      .run({
        workspaceId: account.workspaceId,
        kind: 'job_alert',
        input: { platform: alert.platform, subject: alert.subject, text: alert.text },
        allowManual: false,
        allowTemplate: false,
        useCache: false,
        entityType: 'SearchProfile',
        entityId: profile.id,
      })
      .catch(() => null);
    if (r?.status !== 'succeeded') {
      await this.keepPending(account.id, alert);
      return { status: 'waiting_ai' as const, fresh: 0 };
    }
    const announced = linkedListings(((r.output as { listings?: AlertListing[] }).listings ?? []) as AlertListing[], alert.links);
    const listings: FoundListing[] = [];
    for (const listing of announced) {
      listings.push({ title: listing.title, company: listing.company, location: listing.location ?? null, workMode: listing.workMode, url: await this.listingUrl(listing.url), platform: alert.platform });
    }
    const stats = await this.jobSearch.applyListings(profile, listings, r.taskId, { sourceKind: JOB_ALERT_SOURCE, announced: true });
    await this.noteStats(account.workspaceId, alert, stats.fresh);
    await this.learning.record({ workspaceId: account.workspaceId, kind: 'job_search', aiTaskId: r.taskId, features: { provider: r.provider, set: 'alert', platform: alert.platform, links: alert.links.length }, outcome: { ...stats } });
    return { status: 'processed' as const, fresh: stats.fresh, returned: stats.returned };
  }

  /** Tıklama sayacı bağlantısının gittiği ilan adresi; ilan sayfasının kendisine istek atılmaz, çözülemezse bağlantı olduğu gibi kalır. */
  private async listingUrl(url: string): Promise<string> {
    if (isListingUrl(url)) return url;
    return resolveRedirects(url, isListingUrl, { allowPrivate: env().ALLOW_PRIVATE_FETCH, userAgent: env().HTTP_USER_AGENT }).catch(() => url);
  }

  private async profileOf(account: Pick<MailAccount, 'workspaceId' | 'candidateId'>): Promise<SearchProfile | null> {
    return (
      (await this.prisma.searchProfile.findFirst({ where: { workspaceId: account.workspaceId, candidateId: account.candidateId, active: true }, orderBy: { createdAt: 'asc' } })) ??
      (await this.prisma.searchProfile.findFirst({ where: { workspaceId: account.workspaceId, active: true }, orderBy: { createdAt: 'asc' } }))
    );
  }

  private async pending(accountId: string): Promise<PreparedAlert[]> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: PENDING_KEY(accountId) } });
    return ((kv?.value as { alerts?: PreparedAlert[] } | null)?.alerts ?? []) as PreparedAlert[];
  }

  private async keepPending(accountId: string, alert: PreparedAlert) {
    const tries = (alert.tries ?? 0) + 1;
    if (tries > MAX_PENDING_TRIES) {
      this.logger.warn(`İlan bildirimi işlenemedi ve bırakıldı (${alert.platform}: ${alert.subject})`);
      return;
    }
    const alerts = [...(await this.pending(accountId)), { ...alert, tries }].slice(-MAX_PENDING);
    const value = { alerts } as unknown as Prisma.InputJsonValue;
    await this.prisma.keyValue.upsert({ where: { key: PENDING_KEY(accountId) }, create: { key: PENDING_KEY(accountId), value }, update: { value } });
  }

  private async noteStats(workspaceId: string, alert: PreparedAlert, fresh: number) {
    try {
      const kv = await this.prisma.keyValue.findUnique({ where: { key: STATS_KEY(workspaceId) } });
      const current = (kv?.value ?? { mails: 0, listings: 0, lastAt: null, platforms: {} }) as unknown as StoredStats;
      const next: StoredStats = {
        mails: current.mails + 1,
        listings: current.listings + fresh,
        lastAt: latest(current.lastAt, alert.receivedAt),
        platforms: { ...current.platforms, [alert.platform]: (current.platforms[alert.platform] ?? 0) + 1 },
        lastByPlatform: { ...current.lastByPlatform, [alert.platform]: latest(current.lastByPlatform?.[alert.platform], alert.receivedAt) },
      };
      const value = next as unknown as Prisma.InputJsonValue;
      await this.prisma.keyValue.upsert({ where: { key: STATS_KEY(workspaceId) }, create: { key: STATS_KEY(workspaceId), value }, update: { value } });
    } catch (e) {
      this.logger.warn(`İş alarmı sayacı yazılamadı: ${errorMessage(e)}`);
    }
  }

  async stats(workspaceId: string): Promise<ServerShape<JobAlertStats>> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: STATS_KEY(workspaceId) } });
    const stored = (kv?.value ?? null) as unknown as StoredStats | null;
    const profiles = await this.prisma.searchProfile.findMany({ where: { workspaceId, active: true }, orderBy: { createdAt: 'asc' }, select: { exactTitles: true, city: true, candidate: { select: { city: true } } } });
    const platforms = Object.keys(stored?.platforms ?? {}).sort();
    const lastOf = (platform: string) => stored?.lastByPlatform?.[platform] ?? null;
    return {
      mails: stored?.mails ?? 0,
      listings: stored?.listings ?? 0,
      lastAt: stored?.lastAt ? new Date(stored.lastAt) : null,
      platforms,
      sites: platforms.map((platform) => ({ platform, mails: stored!.platforms[platform], lastAt: lastOf(platform) ? new Date(lastOf(platform)!) : null })),
      searches: alertSearches(profiles.map((p) => ({ exactTitles: p.exactTitles, cities: alertCities(p.candidate.city ?? p.city) }))),
    };
  }
}

/**
 * Postanın bağlantılarını numaralar ve metne "[L3]" biçiminde işler; model ilanı bağlantı adresiyle değil bu numarayla
 * gösterir. Böylece uzun izleme adresleri isteme girmez ve model postada olmayan bir adres uyduramaz.
 */
export function readAlert(mail: Pick<FetchedMail, 'html' | 'text'>): { links: AlertLink[]; text: string } {
  if (mail.html) {
    const $ = cheerio.load(mail.html);
    const anchors = $('a[href]')
      .toArray()
      .map((el) => ({ el, href: ($(el).attr('href') ?? '').trim(), text: $(el).text() || $(el).attr('title') || $(el).find('img[alt]').attr('alt') || '' }));
    const links = alertLinks(anchors);
    const refOf = new Map(links.map((l) => [l.url, l.ref]));
    for (const anchor of anchors) {
      const ref = refOf.get(anchor.href);
      if (ref) $(anchor.el).append(` [${ref}] `);
    }
    return { links, text: htmlToText($.html()).slice(0, ALERT_TEXT_LIMIT) };
  }
  const anchors = [...new Set(mail.text.match(TEXT_URL) ?? [])].map((href) => ({ href: href.replace(/[.,;]+$/, ''), text: 'bağlantı' }));
  const links = alertLinks(anchors);
  let text = mail.text;
  for (const link of links) text = text.split(link.url).join(`[${link.ref}]`);
  return { links, text: text.slice(0, ALERT_TEXT_LIMIT) };
}
