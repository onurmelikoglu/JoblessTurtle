import { DateTime } from 'luxon';

/** Başvurulan firmanın yeni ilanı ancak bu kadar günden yeni yayımlandıysa bildirilir. */
export const FRESH_LISTING_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * İlan güncel mi: kaynaklarından birinin bildirdiği yayın tarihi son FRESH_LISTING_DAYS gün içindeyse; hiçbir kaynak
 * yayın tarihi vermiyorsa ilan yeni görüldüğü için güncel sayılır.
 */
export function isFreshListing(postedAts: (Date | null | undefined)[], now: Date): boolean {
  const known = postedAts.filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
  if (!known.length) return true;
  return Math.max(...known.map((d) => d.getTime())) >= now.getTime() - FRESH_LISTING_DAYS * DAY_MS;
}

/** "Başvurduğun firmada yeni ilan" bildiriminin metni; başvuru başka adla açılmış kayıttaysa o ad da yazılır. */
export function appliedCompanyJobNotice(input: { jobTitle: string; companyName: string; appliedName: string; appliedAt: Date }) {
  const day = DateTime.fromJSDate(input.appliedAt).setZone('Europe/Istanbul').toFormat('dd.LL.yyyy');
  const where = input.appliedName === input.companyName ? 'bu firmaya' : `bu firmaya (${input.appliedName})`;
  return {
    title: `Başvurduğun firmada yeni ilan: ${input.jobTitle} — ${input.companyName}`,
    body: `${day} tarihinde ${where} başvurmuştun. İlan Firmalar listesine eklenmedi ve otomatik başvuru yapılmaz; ilgileniyorsan başvurunun ayrıntısından takip edebilirsin.`,
  };
}
