import { describe, expect, it } from 'vitest';
import type { ExtensionSearch, IsoDate } from '@/api/types';
import { EXTENSION_STEPS, extensionVersion, keySummary, MAX_OPEN_TABS, openAllUrls, pairingCode, SEARCH_SOURCES, searchesOf, searchLabel } from './extension-model';

const search = (patch: Partial<ExtensionSearch>): ExtensionSearch => ({ source: 'indeed', label: 'Indeed', cities: ['İstanbul'], keywords: [], url: 'https://tr.indeed.com/jobs?q=&l=%C4%B0stanbul&sort=date#jt-import', ...patch });
const iso = (value: string) => value as IsoDate;

describe('eklenti aramaları', () => {
  it('menü adı unvan ve şehirden oluşur; Kariyer.net şehir sayfasında yalnızca şehir', () => {
    expect(searchLabel(search({ keywords: ['Flutter Developer'] }))).toBe('Flutter Developer · İstanbul');
    expect(searchLabel(search({ source: 'kariyer_net', keywords: [] }))).toBe('İstanbul');
    expect(searchLabel(search({ source: 'kariyer_net', keywords: ['Creative Director'], cities: ['İstanbul', 'Kocaeli'] }))).toBe('Creative Director · İstanbul, Kocaeli');
    expect(searchLabel(search({ keywords: ['Flutter Developer', 'Mobile Developer'] }))).toBe('Flutter Developer / Mobile Developer · İstanbul');
    expect(searchLabel(search({ source: 'eleman_net', keywords: ['Flutter Developer'], cities: [] }))).toBe('Flutter Developer · Türkiye geneli');
  });

  it('siteye göre ayrılır; veri yoksa boş', () => {
    const all = [search({ source: 'kariyer_net' }), search({ keywords: ['Flutter'] }), search({ keywords: ['Mobile'] })];
    expect(searchesOf(all, 'indeed').map((s) => s.keywords[0])).toEqual(['Flutter', 'Mobile']);
    expect(searchesOf(all, 'kariyer_net')).toHaveLength(1);
    expect(searchesOf(undefined, 'indeed')).toEqual([]);
  });

  it('"Hepsini aç" iki sitenin bütün aramalarını tekrarsız ve sekme sınırına kadar verir', () => {
    const urls = Array.from({ length: 25 }, (_, i) => search({ keywords: [`P${i}`], url: `https://tr.indeed.com/jobs?q=P${i}&l=x&sort=date#jt-import` }));
    expect(openAllUrls([...urls, urls[0]])).toHaveLength(MAX_OPEN_TABS);
    expect(openAllUrls([search({ source: 'kariyer_net', url: 'k#jt-import' }), search({ url: 'i#jt-import' }), search({ url: 'i#jt-import' })])).toEqual(['k#jt-import', 'i#jt-import']);
    expect(openAllUrls(undefined)).toEqual([]);
  });

  it('"Hepsini aç" siteleri sırayla döner; sınır aşılınca da her siteden arama açılır', () => {
    const many = (source: ExtensionSearch['source'], n: number) => Array.from({ length: n }, (_, i) => search({ source, url: `${source}-${i}#jt-import` }));
    const urls = openAllUrls([...many('kariyer_net', 10), ...many('indeed', 10), ...many('yenibiris', 1)]);
    expect(urls.slice(0, 4)).toEqual(['kariyer_net-0#jt-import', 'indeed-0#jt-import', 'yenibiris-0#jt-import', 'kariyer_net-1#jt-import']);
    expect(urls).toHaveLength(MAX_OPEN_TABS);
  });

  it('altı sitenin her biri için arama düğmesi', () => {
    expect(SEARCH_SOURCES.map((s) => s.source)).toEqual(['kariyer_net', 'indeed', 'eleman_net', 'isinolsun', 'secretcv', 'yenibiris']);
  });

  it('eklenti köprüsü uygulama sayfasını işaretler', () => {
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    expect(extensionVersion(root)).toBeNull();
    (root.dataset as Record<string, string>).jtExtension = '1.1.0';
    expect(extensionVersion(root)).toBe('1.1.0');
  });
});

describe('eklenti anahtarı', () => {
  const fmt = (value: string) => value.slice(0, 10);

  it('durum özeti: anahtar yok, kullanılmamış, kullanılmış', () => {
    expect(keySummary({ exists: false, created_at: null, last_used_at: null }, fmt)).toBe('Henüz anahtar yok.');
    expect(keySummary({ exists: true, created_at: iso('2026-10-23T09:00:00Z'), last_used_at: null }, fmt)).toBe('Anahtar 2026-10-23 üretildi; eklenti henüz bu anahtarla bağlanmadı.');
    expect(keySummary({ exists: true, created_at: iso('2026-10-23T09:00:00Z'), last_used_at: iso('2026-10-24T09:00:00Z') }, fmt)).toBe('Anahtar 2026-10-23 üretildi; son kullanım 2026-10-24.');
  });

  it('kurulum adımları indirmeyi, Chrome sayfasını ve eşleştirme kodunu anar', () => {
    expect(EXTENSION_STEPS.join(' ')).toContain('chrome://extensions');
    expect(EXTENSION_STEPS.join(' ')).toContain('Eklentiyi indir');
    expect(EXTENSION_STEPS.join(' ')).toContain('eşleştirme kodu');
  });

  it('eşleştirme kodu eklentinin çözdüğü biçimde adres ve anahtarı taşır (Türkçe karakter dahil)', () => {
    const code = pairingCode('https://iş.ornek.com', 'jt_abc+/=');
    expect(code).toMatch(/^jt1\.[A-Za-z0-9_-]+$/);
    const binary = atob(code.slice(4).replace(/-/g, '+').replace(/_/g, '/'));
    const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
    expect(data).toEqual({ u: 'https://iş.ornek.com', k: 'jt_abc+/=' });
  });
});
