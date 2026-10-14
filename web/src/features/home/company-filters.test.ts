import { describe, expect, it } from 'vitest';
import type { HomeCompany, HomeOpportunity, IsoDate } from '@/api/types';
import { activeFilterCount, DEFAULT_FILTERS, filterCompanies, focusCompanies, groupByClass, isFocused, parseFilters, scopeCounts, sizeBucketOf, sizeCounts, writeFilters } from './company-filters';

const at = (iso: string) => iso as IsoDate;

function opportunity(patch: Partial<HomeOpportunity> = {}): HomeOpportunity {
  return {
    id: 'o1',
    companyId: 'c1',
    jobId: null,
    title: null,
    category: 'sector_target',
    company: 'Firma',
    website: null,
    careersUrl: null,
    location: null,
    scope: 'local',
    applyUrl: null,
    formOnly: false,
    canEmail: true,
    groupSuggestion: null,
    emailSearchExhausted: false,
    fit: 'good',
    summary: '',
    analysis: null,
    draft: null,
    links: [],
    foundAt: at('2026-10-01T00:00:00Z'),
    rank: null,
    ...patch,
  };
}

function company(patch: Partial<HomeCompany> = {}): HomeCompany {
  return {
    id: 'c1',
    name: 'Firma',
    website: null,
    careersUrl: null,
    class: 'potential',
    sectors: [],
    cities: [],
    employees: null,
    analysis: null,
    offices: [],
    regionMatch: 'unknown',
    opportunities: [opportunity()],
    matchingJobs: 0,
    researching: false,
    links: [],
    foundAt: at('2026-10-01T00:00:00Z'),
    ...patch,
  };
}

const ready = { id: 'd', status: 'draft', revision: 1, subject: 's', body: 'b', toEmail: 'ik@teslimatfirma.com', problems: [] };

const getir = company({
  id: 'getir',
  name: 'Getir',
  class: 'open',
  sectors: ['hızlı teslimat'],
  cities: ['İstanbul'],
  regionMatch: 'yes',
  matchingJobs: 1,
  employees: { range: '1001-5000', count: 4200 },
  offices: [{ id: 'of1', label: 'Genel Merkez', kind: 'hq', city: 'İstanbul', district: 'Beşiktaş', address: 'Etiler Mah.', inRegion: true }],
  opportunities: [opportunity({ id: 'g1', jobId: 'j1', title: 'Senior iOS Developer', category: 'target_open', location: 'İstanbul', draft: ready, foundAt: at('2026-10-10T00:00:00Z') })],
});
const insider = company({
  id: 'insider',
  name: 'Insider',
  class: 'past',
  sectors: ['SaaS'],
  cities: ['İstanbul', 'Ankara'],
  employees: { range: '501-1000', count: null },
  regionMatch: 'no',
  foundAt: at('2026-10-12T00:00:00Z'),
  opportunities: [opportunity({ id: 'i1', jobId: 'j2', title: 'Flutter Developer', category: 'past_closed', canEmail: false })],
});
const ciceksepeti = company({
  id: 'cs',
  name: 'Çiçeksepeti',
  class: 'potential',
  sectors: ['e-ticaret'],
  cities: ['İzmir'],
  website: 'https://www.ciceksepeti.com',
  opportunities: [opportunity({ id: 'c1', canEmail: true }), opportunity({ id: 'c2', canEmail: false, groupSuggestion: { email: 'ik@grup.com', kind: 'group_hr', groupName: 'Grup', sourceUrl: null, label: 'Grup İK', note: '' } })],
});
const all = [getir, insider, ciceksepeti];
const names = (list: HomeCompany[]) => list.map((c) => c.name);
const filter = (patch: Partial<typeof DEFAULT_FILTERS>) => filterCompanies(all, { ...DEFAULT_FILTERS, ...patch });

describe('firma araması', () => {
  it('firma adı, şehir, ilçe, sektör ve ilan başlığında arar', () => {
    expect(names(filter({ query: 'getir' }))).toEqual(['Getir']);
    expect(names(filter({ query: 'ankara' }))).toEqual(['Insider']);
    expect(names(filter({ query: 'beşiktaş' }))).toEqual(['Getir']);
    expect(names(filter({ query: 'e-ticaret' }))).toEqual(['Çiçeksepeti']);
    expect(names(filter({ query: 'flutter' }))).toEqual(['Insider']);
  });

  it('Türkçe karakter ve büyük/küçük harf farkını yok sayar', () => {
    expect(names(filter({ query: 'ISTANBUL' }))).toEqual(['Getir', 'Insider']);
    expect(names(filter({ query: 'İZMİR' }))).toEqual(['Çiçeksepeti']);
    expect(names(filter({ query: 'ciceksepeti' }))).toEqual(['Çiçeksepeti']);
    expect(names(filter({ query: 'besiktas' }))).toEqual(['Getir']);
  });

  it('birden çok kelimenin hepsi eşleşmelidir, sırası önemsizdir', () => {
    expect(names(filter({ query: 'istanbul ios' }))).toEqual(['Getir']);
    expect(names(filter({ query: 'developer istanbul' }))).toEqual(['Getir', 'Insider']);
    expect(names(filter({ query: 'ankara ios' }))).toEqual([]);
  });

  it('site adresi, etiket ve alıcı adresiyle de bulunur', () => {
    expect(names(filter({ query: 'ciceksepeti.com' }))).toEqual(['Çiçeksepeti']);
    expect(names(filter({ query: 'kapanmış' }))).toEqual(['Insider']);
    expect(names(filter({ query: 'ik@teslimatfirma.com' }))).toEqual(['Getir']);
  });
});

describe('firma filtreleri', () => {
  it('sınıf ve bölge filtresi', () => {
    expect(names(filter({ classes: ['open', 'past'] }))).toEqual(['Getir', 'Insider']);
    expect(names(filter({ inRegion: true }))).toEqual(['Getir']);
  });

  it('mail filtresi fırsat düzeyinde çalışır ve yalnızca uyan fırsatları bırakır', () => {
    const missing = filter({ email: 'missing' });
    expect(names(missing)).toEqual(['Insider', 'Çiçeksepeti']);
    expect(missing[1].opportunities.map((o) => o.id)).toEqual(['c2']);
    const has = filter({ email: 'has' });
    expect(names(has)).toEqual(['Getir', 'Çiçeksepeti']);
    expect(has[1].opportunities.map((o) => o.id)).toEqual(['c1']);
  });

  it('çalışan sayısı filtresi: seçilen dilimlerden birine giren firmalar; sayısı bilinmeyen ayrı dilimdir', () => {
    expect(names(filter({ sizes: ['1000+'] }))).toEqual(['Getir']);
    expect(names(filter({ sizes: ['201-1000', 'bilinmiyor'] }))).toEqual(['Insider', 'Çiçeksepeti']);
    expect(names(filter({ sizes: ['11-50'] }))).toEqual([]);
    expect(sizeBucketOf({ range: '201-500', count: 300 })).toBe('201-1000');
    expect(sizeBucketOf({ range: '5001+', count: null })).toBe('1000+');
    expect(sizeBucketOf(null)).toBe('bilinmiyor');
    expect(sizeCounts(all)).toEqual({ '1-10': 0, '11-50': 0, '51-200': 0, '201-1000': 1, '1000+': 1, bilinmiyor: 1 });
  });

  it('kapsam filtresi fırsat düzeyindedir; konumu bilinmeyen ilan Türkiye dilimindedir', () => {
    const mixed = company({ id: 'mx', name: 'Karma', opportunities: [opportunity({ id: 'm1', scope: 'remote' }), opportunity({ id: 'm2', scope: 'abroad' }), opportunity({ id: 'm3', scope: 'unknown' })] });
    const list = [getir, mixed];
    const only = (scopes: (typeof DEFAULT_FILTERS)['scopes']) => filterCompanies(list, { ...DEFAULT_FILTERS, scopes });
    expect(only(['uzaktan']).map((c) => [c.name, c.opportunities.map((o) => o.id)])).toEqual([['Karma', ['m1']]]);
    expect(only(['yurtdisi', 'uzaktan'])[0].opportunities.map((o) => o.id)).toEqual(['m1', 'm2']);
    expect(only(['tr']).map((c) => [c.name, c.opportunities.map((o) => o.id)])).toEqual([['Getir', ['g1']], ['Karma', ['m3']]]);
    expect(scopeCounts(list)).toEqual({ tr: 2, uzaktan: 1, yurtdisi: 1 });
  });

  it('yazısı hazır filtresi', () => {
    expect(names(filter({ ready: true }))).toEqual(['Getir']);
  });

  it('filtreler birlikte uygulanır', () => {
    expect(names(filter({ query: 'istanbul', classes: ['past'] }))).toEqual(['Insider']);
    expect(names(filter({ query: 'istanbul', email: 'has' }))).toEqual(['Getir']);
  });

  it('sıralama: önerilen sırayı korur, en yeni ve ada göre sıralar; girdiyi değiştirmez', () => {
    expect(names(filter({}))).toEqual(['Getir', 'Insider', 'Çiçeksepeti']);
    expect(names(filter({ sort: 'newest' }))).toEqual(['Insider', 'Getir', 'Çiçeksepeti']);
    expect(names(filter({ sort: 'name' }))).toEqual(['Çiçeksepeti', 'Getir', 'Insider']);
    expect(names(all)).toEqual(['Getir', 'Insider', 'Çiçeksepeti']);
  });

  it('sınıfa göre gruplar ve boş sınıfı atlar', () => {
    expect(groupByClass([getir, ciceksepeti]).map((g) => [g.companyClass, g.companies.length])).toEqual([
      ['open', 1],
      ['potential', 1],
    ]);
  });
});

describe('filtrelerin adres çubuğunda tutulması', () => {
  it('varsayılanlar yazılmaz, diğer parametreler korunur', () => {
    const params = writeFilters(new URLSearchParams('tab=firmalar'), DEFAULT_FILTERS);
    expect(params.toString()).toBe('tab=firmalar');
  });

  it('yazılan filtre aynen geri okunur', () => {
    const filters = { query: 'ankara ios', classes: ['open', 'potential'] as const, sizes: ['11-50', '1000+', 'bilinmiyor'] as const, scopes: ['uzaktan', 'yurtdisi'] as const, inRegion: true, email: 'missing' as const, ready: true, sort: 'newest' as const };
    const params = writeFilters(new URLSearchParams(), { ...filters, classes: [...filters.classes], sizes: [...filters.sizes], scopes: [...filters.scopes] });
    expect(parseFilters(new URLSearchParams(params.toString()))).toEqual({ ...filters, classes: [...filters.classes], sizes: [...filters.sizes], scopes: [...filters.scopes] });
    expect(activeFilterCount(parseFilters(params))).toBe(7);
  });

  it('bozuk parametreleri yok sayar', () => {
    expect(parseFilters(new URLSearchParams('sinif=open,xyz&boyut=51-200,devasa&kapsam=uzaktan,ay&mail=belki&sira=rastgele'))).toEqual({ ...DEFAULT_FILTERS, classes: ['open'], sizes: ['51-200'], scopes: ['uzaktan'] });
  });
});

describe('bildirimden gelinen odak', () => {
  const a = company({ id: 'c1', name: 'Remax Yaman', opportunities: [opportunity({ id: 'o1', jobId: 'j1' }), opportunity({ id: 'o2', jobId: 'j2' })] });
  const b = company({ id: 'c2', name: 'Örnek Ajans', opportunities: [opportunity({ id: 'o3', jobId: 'j3' })] });
  const c = company({ id: 'c3', name: 'Defter', opportunities: [opportunity({ id: 'o4', jobId: null })] });

  it('yalnızca odaktaki ilanları ve fırsatları, kendi firmalarıyla gösterir', () => {
    const shown = focusCompanies([a, b, c], { jobs: ['j1', 'j3'], opportunities: [] });
    expect(shown.map((x) => [x.id, x.opportunities.map((o) => o.id)])).toEqual([
      ['c1', ['o1']],
      ['c2', ['o3']],
    ]);
    expect(focusCompanies([a, b, c], { jobs: [], opportunities: ['o4'] }).map((x) => x.id)).toEqual(['c3']);
  });

  it('listede kalmayan ilan için boş sonuç döner; odak yoksa odak kapalıdır', () => {
    expect(focusCompanies([a, b], { jobs: ['yok'], opportunities: [] })).toEqual([]);
    expect(isFocused({ jobs: [], opportunities: [] })).toBe(false);
    expect(isFocused({ jobs: ['j1'], opportunities: [] })).toBe(true);
  });
});
