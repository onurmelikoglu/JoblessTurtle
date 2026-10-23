import { describe, expect, it } from 'vitest';
import type { IsoDate, ScraperRunView } from '@/api/types';
import { errorKinds, healthOf, isActive, keywordNote, runSourceLabel, runSummary, stateLabel } from './scrapers-model';

const at = '2026-10-20T09:00:00Z' as IsoDate;

function run(patch: Partial<ScraperRunView>): ScraperRunView {
  return { id: 'r1', source: 'kariyer_net', trigger: 'manual', state: 'succeeded', cities: ['İstanbul'], keywords: [], max_pages: 5, pages_visited: 3, pages_failed: 0, listings_found: 159, listings_new: 12, listings_updated: 0, duplicates: 0, forwarded: 2, error_summary: null, errors: [], queued_at: at, started_at: at, finished_at: at, duration_ms: 1000, ...patch };
}

describe('ilan sitesi taraması ekranı', () => {
  it('çalışma özeti sayfa, ilan ve hatalı sayfa sayısını yazar', () => {
    expect(runSummary(run({}))).toBe('3 sayfa · 159 ilan, 12 yeni');
    expect(runSummary(run({ listings_updated: 2, pages_failed: 1 }))).toBe('3 sayfa · 159 ilan, 12 yeni, 2 güncellenen · 1 sayfa alınamadı');
  });

  it('hata türleri tekrarsız ve okunur adlarıyla yazılır', () => {
    const errors = [
      { kind: 'blocked', message: 'x', at },
      { kind: 'selector', message: 'y', at },
      { kind: 'blocked', message: 'z', at },
    ] as ScraperRunView['errors'];
    expect(errorKinds(run({ errors }))).toBe('erişim engeli, sayfa düzeni değişmiş');
  });

  it('durum ve sağlık etiketleri', () => {
    expect(healthOf('blocked')).toEqual({ label: 'Site engelledi', tone: 'bad' });
    expect(healthOf('never').tone).toBe('neutral');
    expect(stateLabel('rate_limited')).toBe('İstek sınırı');
  });

  it('sırada ya da çalışan tarama varsa etkin sayılır', () => {
    const idle = { active_run: null } as never;
    expect(isActive([idle])).toBe(false);
    expect(isActive([idle, { active_run: run({ state: 'running' }) } as never])).toBe(true);
    expect(isActive(undefined)).toBe(false);
  });

  it('anahtar kelime notu sitenin arama biçimine göre değişir', () => {
    expect(keywordNote({ keyword_mode: 'local_filter', keywords: [] })).toContain('tüm yeni ilanlar');
    expect(keywordNote({ keyword_mode: 'local_filter', keywords: ['Flutter'] })).toContain('süzülür');
    expect(keywordNote({ keyword_mode: 'query', keywords: ['Flutter'] })).toContain('sitenin aramasında');
  });
});

describe('çalışmanın kaynağı', () => {
  it('eklentiden gelen aktarım sunucu taramasından ayrılır', () => {
    expect(runSourceLabel(run({}))).toBe('Kariyer.net');
    expect(runSourceLabel(run({ source: 'indeed', trigger: 'extension' }))).toBe('Indeed (eklenti)');
  });
});
