import { clearSince, decodeNotificationCursor, encodeNotificationCursor, FOLD_FROM, FOLD_TO, listWindow, searchTokens } from '../../src/domain/notifications';
import { fold } from '../../src/domain/text';

const NOW = new Date('2026-10-23T12:00:00Z');
const HOUR = 3_600_000;

describe('bildirim geçmişini temizleme kapsamları', () => {
  it('son 1 saat, 24 saat ve 7 gün şimdiden geriye sayılır; tümü sınırsızdır', () => {
    expect(clearSince('1h', NOW)?.getTime()).toBe(NOW.getTime() - HOUR);
    expect(clearSince('24h', NOW)?.getTime()).toBe(NOW.getTime() - 24 * HOUR);
    expect(clearSince('7d', NOW)?.getTime()).toBe(NOW.getTime() - 7 * 24 * HOUR);
    expect(clearSince('all', NOW)).toBeNull();
  });
});

describe('bildirim listeleme penceresi', () => {
  const cutoff = new Date('2026-09-23T12:00:00Z');

  it('başlangıç verilmezse ya da saklama sınırından eskiyse sınıra çekilir', () => {
    expect(listWindow(cutoff)).toEqual({ gte: cutoff });
    expect(listWindow(cutoff, new Date('2026-08-01T00:00:00Z'))).toEqual({ gte: cutoff });
  });

  it('sınır içindeki başlangıç ve bitiş olduğu gibi kalır', () => {
    const from = new Date('2026-10-20T08:00:00Z');
    const to = new Date('2026-10-21T18:30:00Z');
    expect(listWindow(cutoff, from, to)).toEqual({ gte: from, lte: to });
  });
});

describe('bildirim araması', () => {
  it('büyük/küçük harf ve Türkçe harf farkı gözetmeden sözcüklere böler', () => {
    expect(searchTokens('  İŞ Başvurusu  ')).toEqual(['is', 'basvurusu']);
    expect(searchTokens('ÇAĞRI ılık')).toEqual(['cagri', 'ilik']);
    expect(searchTokens('mail-dönüşü / mail')).toEqual(['mail', 'donusu']);
  });

  it('boş ya da yalnızca noktalama içeren arama süzgeç oluşturmaz', () => {
    expect(searchTokens('')).toEqual([]);
    expect(searchTokens(undefined)).toEqual([]);
    expect(searchTokens(' %_ ')).toEqual([]);
  });

  it('LIKE kalıbına giren sözcüklerde joker ya da kaçış karakteri kalmaz', () => {
    for (const token of searchTokens('100% _test_ a\\b')) expect(token).toMatch(/^[a-z0-9@.+]+$/);
  });

  it('veritabanı sadeleştirme tablosu `fold` ile aynı sonucu verir', () => {
    expect([...FOLD_FROM]).toHaveLength([...FOLD_TO].length);
    [...FOLD_FROM].forEach((source, index) => expect(fold(source)).toBe(FOLD_TO[index]));
  });
});

describe('bildirim sayfa imleci', () => {
  it('oluşturulma anı ve kimlik gidip geri gelir', () => {
    const row = { createdAt: new Date('2026-10-22T09:15:30.123Z'), id: 'cmb2x0abc123' };
    expect(decodeNotificationCursor(encodeNotificationCursor(row))).toEqual(row);
  });

  it('bozuk imleç reddedilir', () => {
    for (const bad of ['', 'abc', '123', '_id', '12_ab cd', "1_x';drop"]) expect(decodeNotificationCursor(bad)).toBeNull();
  });
});
