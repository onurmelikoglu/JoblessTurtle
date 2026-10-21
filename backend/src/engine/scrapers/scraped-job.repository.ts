import { Injectable } from '@nestjs/common';
import { Prisma, ScrapedJob } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { contentHashOf, ScrapedListing, similarityKeyOf, staleCutoffs } from '../../domain/scraped-jobs';
import { ScraperConfig, ScraperSource } from '../../domain/scraper-config';

/**
 * new: ilk kez görüldü. repost: yeni numara ama aynı sitede aynı firma + unvan + şehirle etkin bir ilan zaten var
 * (yeniden yayımlanmış ilan; kaydedilir ama yeni sayılmaz). updated: içerik değişti ya da kaybolan ilan yeniden görüldü.
 * seen: değişiklik yok, yalnızca son görülme zamanı ilerledi.
 */
export type UpsertOutcome = 'new' | 'repost' | 'updated' | 'seen';

export interface ScrapedJobQuery {
  source?: string;
  city?: string;
  company?: string;
  title?: string;
  status?: string;
  from?: Date;
  to?: Date;
  newSince?: Date;
  includeDuplicates?: boolean;
  cursor?: string;
  limit: number;
}

const ACTIVE_STATUSES = ['active', 'missing'];

@Injectable()
export class ScrapedJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  private async similarActive(listing: ScrapedListing, similarityKey: string): Promise<Pick<ScrapedJob, 'id' | 'source'> | null> {
    return this.prisma.scrapedJob.findFirst({
      where: { similarityKey, city: { equals: listing.city, mode: 'insensitive' }, status: { in: ACTIVE_STATUSES }, duplicateOfId: null, NOT: { source: listing.source, externalId: listing.externalId } },
      orderBy: { firstSeenAt: 'asc' },
      select: { id: true, source: true },
    });
  }

  /**
   * Upsert: (site, ilan numarası) tekil anahtardır. Yeni kayıtta yardımcı benzerlik kontrolü yapılır; mevcut kayıtta
   * first_seen_at korunur, last_seen_at ilerler, içerik özeti değiştiyse alanlar güncellenir. Eşzamanlı ekleme
   * çakışmasında (P2002) kayıt güncelleme yoluna döner.
   */
  async upsert(listing: ScrapedListing, runId: string, now: Date): Promise<{ outcome: UpsertOutcome; row: ScrapedJob }> {
    const contentHash = contentHashOf(listing);
    const similarityKey = similarityKeyOf(listing.companyName, listing.jobTitle);
    const fields = {
      similarityKey,
      companyName: listing.companyName,
      jobTitle: listing.jobTitle,
      city: listing.city,
      district: listing.district,
      jobUrl: listing.jobUrl,
      companyUrl: listing.companyUrl,
      description: listing.description,
      employmentType: listing.employmentType,
      workMode: listing.workMode,
      contentHash,
    };
    const key = { source_externalId: { source: listing.source, externalId: listing.externalId } };
    const existing = await this.prisma.scrapedJob.findUnique({ where: key });
    if (!existing) {
      const similar = await this.similarActive(listing, similarityKey);
      try {
        const row = await this.prisma.scrapedJob.create({
          data: {
            source: listing.source,
            externalId: listing.externalId,
            ...fields,
            publishedAt: listing.publishedAt,
            publishedText: listing.publishedText,
            duplicateOfId: similar?.id ?? null,
            firstSeenAt: now,
            lastSeenAt: now,
            firstRunId: runId,
            lastRunId: runId,
          },
        });
        return { outcome: similar?.source === listing.source ? 'repost' : 'new', row };
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        return this.upsert(listing, runId, now);
      }
    }
    const changed = existing.contentHash !== contentHash;
    const revived = existing.status !== 'active';
    const row = await this.prisma.scrapedJob.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: now,
        lastRunId: runId,
        status: 'active',
        publishedText: listing.publishedText ?? existing.publishedText,
        publishedAt: existing.publishedAt ?? listing.publishedAt,
        ...(changed ? { ...fields, contentChangedAt: now } : {}),
      },
    });
    return { outcome: changed || revived ? 'updated' : 'seen', row };
  }

  /** Uzun süre görülmeyen ilanlar silinmez: önce "missing", sonra "expired" olur. */
  async markStale(source: ScraperSource, now: Date, config: Pick<ScraperConfig, 'missing_after_hours' | 'expire_after_days'>) {
    const { missingBefore, expiredBefore } = staleCutoffs(now, config);
    const expired = await this.prisma.scrapedJob.updateMany({ where: { source, status: { in: ACTIVE_STATUSES }, lastSeenAt: { lt: expiredBefore } }, data: { status: 'expired' } });
    const missing = await this.prisma.scrapedJob.updateMany({ where: { source, status: 'active', lastSeenAt: { lt: missingBefore } }, data: { status: 'missing' } });
    return { missing: missing.count, expired: expired.count };
  }

  private where(q: ScrapedJobQuery): Prisma.ScrapedJobWhereInput {
    const contains = (value: string | undefined) => (value?.trim() ? { contains: value.trim(), mode: 'insensitive' as const } : undefined);
    const firstSeen: Prisma.DateTimeFilter = {};
    if (q.from) firstSeen.gte = q.from;
    if (q.to) firstSeen.lte = q.to;
    if (q.newSince && (!firstSeen.gte || q.newSince > firstSeen.gte)) firstSeen.gte = q.newSince;
    return {
      ...(q.source ? { source: q.source } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.city ? { OR: [{ city: contains(q.city) }, { district: contains(q.city) }] } : {}),
      ...(q.company ? { companyName: contains(q.company) } : {}),
      ...(q.title ? { jobTitle: contains(q.title) } : {}),
      ...(Object.keys(firstSeen).length ? { firstSeenAt: firstSeen } : {}),
      ...(q.includeDuplicates ? {} : { duplicateOfId: null }),
    };
  }

  /** En yeni önce; imleç (cursor) sayfalaması. */
  async list(q: ScrapedJobQuery) {
    const where = this.where(q);
    const [rows, total] = await Promise.all([
      this.prisma.scrapedJob.findMany({ where, orderBy: [{ firstSeenAt: 'desc' }, { id: 'desc' }], take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) }),
      this.prisma.scrapedJob.count({ where }),
    ]);
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    return { items, total, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  findById(id: string) {
    return this.prisma.scrapedJob.findUnique({ where: { id } });
  }
}
