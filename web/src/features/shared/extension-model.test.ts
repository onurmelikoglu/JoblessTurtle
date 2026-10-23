import { describe, expect, it } from 'vitest';
import type { ExtensionSearch, IsoDate } from '@/api/types';
import { EXTENSION_FOLDER, EXTENSION_STEPS, keySummary, searchesOf, searchLabel } from './extension-model';

const search = (patch: Partial<ExtensionSearch>): ExtensionSearch => ({ source: 'indeed', label: 'Indeed', city: 'İstanbul', keyword: null, url: 'https://tr.indeed.com/jobs?q=&l=%C4%B0stanbul&sort=date#jt-import', ...patch });
const iso = (value: string) => value as IsoDate;

describe('eklenti aramaları', () => {
  it('menü adı unvan ve şehirden oluşur; Kariyer.net şehir sayfasında yalnızca şehir', () => {
    expect(searchLabel(search({ keyword: 'Flutter Developer' }))).toBe('Flutter Developer · İstanbul');
    expect(searchLabel(search({ source: 'kariyer_net', keyword: null }))).toBe('İstanbul');
  });

  it('siteye göre ayrılır; veri yoksa boş', () => {
    const all = [search({ source: 'kariyer_net' }), search({ keyword: 'Flutter' }), search({ keyword: 'Mobile' })];
    expect(searchesOf(all, 'indeed').map((s) => s.keyword)).toEqual(['Flutter', 'Mobile']);
    expect(searchesOf(all, 'kariyer_net')).toHaveLength(1);
    expect(searchesOf(undefined, 'indeed')).toEqual([]);
  });
});

describe('eklenti anahtarı', () => {
  const fmt = (value: string) => value.slice(0, 10);

  it('durum özeti: anahtar yok, kullanılmamış, kullanılmış', () => {
    expect(keySummary({ exists: false, created_at: null, last_used_at: null }, fmt)).toBe('Henüz anahtar yok.');
    expect(keySummary({ exists: true, created_at: iso('2026-10-23T09:00:00Z'), last_used_at: null }, fmt)).toBe('Anahtar 2026-10-23 üretildi; eklenti henüz bu anahtarla bağlanmadı.');
    expect(keySummary({ exists: true, created_at: iso('2026-10-23T09:00:00Z'), last_used_at: iso('2026-10-24T09:00:00Z') }, fmt)).toBe('Anahtar 2026-10-23 üretildi; son kullanım 2026-10-24.');
  });

  it('kurulum adımları eklenti klasörünü ve Chrome sayfasını anar', () => {
    expect(EXTENSION_STEPS.join(' ')).toContain('chrome://extensions');
    expect(EXTENSION_STEPS.join(' ')).toContain(EXTENSION_FOLDER);
  });
});
