import { describe, expect, it } from 'vitest';
import {
  CLEAR_OPTIONS,
  clearConfirm,
  clearedMessage,
  EMPTY_FILTERS,
  hasActiveFilters,
  listParams,
  PAGE_SIZE,
  parseLocalInput,
  presetRange,
  rangeError,
  resultSummary,
  toLocalInput,
  togglePreset,
  type NotificationFilters,
} from './notifications-model';

const filters = (patch: Partial<NotificationFilters> = {}): NotificationFilters => ({ ...EMPTY_FILTERS, ...patch });
const NOW = new Date(2026, 9, 23, 14, 37, 12);

describe('tarih-saat alanı dönüşümü', () => {
  it('yerel saatle dakika duyarlılığında gidip gelir', () => {
    expect(toLocalInput(new Date(2026, 0, 5, 9, 4, 59))).toBe('2026-01-05T09:04');
    expect(parseLocalInput('2026-01-05T09:04')?.getTime()).toBe(new Date(2026, 0, 5, 9, 4).getTime());
  });

  it('boş ya da bozuk değer tarih vermez', () => {
    expect(parseLocalInput('')).toBeNull();
    expect(parseLocalInput('dün')).toBeNull();
  });
});

describe('hazır aralıklar', () => {
  it('başlangıcı şimdiden geriye sayar, bitişi açık bırakır', () => {
    expect(presetRange('1h', NOW)).toEqual({ from: '2026-10-23T13:37', to: '', preset: '1h' });
    expect(presetRange('24h', NOW)).toEqual({ from: '2026-10-22T14:37', to: '', preset: '24h' });
    expect(presetRange('7d', NOW)).toEqual({ from: '2026-10-16T14:37', to: '', preset: '7d' });
  });

  it('bugün gece yarısından başlar', () => {
    expect(presetRange('today', NOW).from).toBe('2026-10-23T00:00');
  });

  it('seçili aralığa yeniden basınca aralık kalkar, başkasına basınca o seçilir', () => {
    expect(togglePreset('24h', '24h', NOW)).toEqual({ from: '', to: '', preset: null });
    expect(togglePreset('24h', '1h', NOW)).toEqual(presetRange('1h', NOW));
    expect(togglePreset(null, '7d', NOW).preset).toBe('7d');
  });
});

describe('süzgeç doğrulama ve sorgu', () => {
  it('başlangıç bitişten sonraysa hata verir', () => {
    expect(rangeError({ from: '2026-10-23T10:00', to: '2026-10-22T10:00' })).toMatch(/Başlangıç/);
    expect(rangeError({ from: '2026-10-22T10:00', to: '2026-10-22T10:00' })).toBeNull();
    expect(rangeError({ from: '2026-10-22T10:00', to: '' })).toBeNull();
  });

  it('boş süzgeç yalnızca sayfa boyutunu gönderir', () => {
    expect(listParams(EMPTY_FILTERS)).toEqual({ q: undefined, from: undefined, to: undefined, unread: undefined, limit: PAGE_SIZE, cursor: undefined });
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters(filters({ query: '   ' }))).toBe(false);
  });

  it('metni kırpar, tarihleri ISO 8601 yapar, bitişi seçilen dakikanın sonuna uzatır', () => {
    const params = listParams(filters({ query: '  mail dönüşü ', from: '2026-10-20T08:00', to: '2026-10-21T18:30', unread: true }), 'imlec');
    expect(params.q).toBe('mail dönüşü');
    expect(params.from).toBe(new Date(2026, 9, 20, 8, 0).toISOString());
    expect(params.to).toBe(new Date(2026, 9, 21, 18, 30, 59, 999).toISOString());
    expect(params.unread).toBe(true);
    expect(params.cursor).toBe('imlec');
  });

  it('süzgeç açıkken sonuç metni bunu söyler', () => {
    expect(resultSummary(12, false)).toBe('12 bildirim');
    expect(resultSummary(3, true)).toBe('Filtreye uyan 3 bildirim');
  });
});

describe('geçmişi temizleme', () => {
  it('tarayıcı geçmişi gibi dört kapsam sunar', () => {
    expect(CLEAR_OPTIONS.map((o) => [o.range, o.label])).toEqual([
      ['1h', 'Son 1 saat'],
      ['24h', 'Son 24 saat'],
      ['7d', 'Son 1 hafta'],
      ['all', 'Tümü'],
    ]);
  });

  it('onay metni silinecek kapsamı söyler', () => {
    expect(clearConfirm('1h', false)).toMatchObject({ title: 'Son 1 saatin bildirimleri silinsin mi?', danger: true, confirmLabel: 'Sil' });
    expect(clearConfirm('7d', false).message).toMatch(/Son 7 günde gelen bütün bildirimler silinir/);
    expect(clearConfirm('all', false).title).toBe('Tüm bildirimler silinsin mi?');
    expect(clearConfirm('24h', false).message).not.toMatch(/filtre/);
    expect(clearConfirm('24h', true).message).toMatch(/filtresi silmeye uygulanmaz/);
  });

  it('sonuç mesajı silinen sayıyı verir', () => {
    expect(clearedMessage(4)).toBe('4 bildirim silindi.');
    expect(clearedMessage(0)).toMatch(/silinecek bildirim yoktu/);
  });
});
