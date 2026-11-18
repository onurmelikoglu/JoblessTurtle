import { describe, expect, it } from 'vitest';
import type { DirectoryCompany } from '@/api/types';
import { applicationStatus, filterDirectory, lastApplyText, parseView, writeView } from './directory-model';

function company(patch: Partial<DirectoryCompany>): DirectoryCompany {
  return {
    id: 'c',
    name: 'Firma',
    aliases: [],
    website: null,
    cities: [],
    sectors: [],
    employees: null,
    openJobs: 0,
    totalJobs: 0,
    lastJobAt: null,
    applications: 0,
    lastAppliedAt: null,
    replies: 0,
    lastReplyAt: null,
    newSinceApply: 0,
    hasOpportunity: false,
    foundAt: '2026-10-01T00:00:00Z' as DirectoryCompany['foundAt'],
    ...patch,
  };
}

const at = (iso: string) => iso as DirectoryCompany['lastAppliedAt'];
const defne = company({ id: 'd', name: 'Defne Medya', aliases: ['Defne Ajans'], applications: 2, lastAppliedAt: at('2026-11-01T00:00:00Z'), replies: 1, newSinceApply: 1, lastJobAt: at('2026-11-05T00:00:00Z') });
const zeytin = company({ id: 'z', name: 'Zeytin Yazılım', applications: 1, lastAppliedAt: at('2026-11-08T00:00:00Z'), lastJobAt: at('2026-10-01T00:00:00Z') });
const bos = company({ id: 'b', name: 'Bambu', lastJobAt: at('2026-11-09T00:00:00Z') });
const all = [defne, zeytin, bos];
const names = (list: DirectoryCompany[]) => list.map((c) => c.name);

describe('Şirketler listesi', () => {
  it('varsayılan sıra son başvuru; hiç başvurulmayanlar sonda', () => {
    expect(names(filterDirectory(all, { query: '', filter: 'tum', sort: 'son-basvuru' }))).toEqual(['Zeytin Yazılım', 'Defne Medya', 'Bambu']);
    expect(names(filterDirectory(all, { query: '', filter: 'tum', sort: 'son-ilan' }))).toEqual(['Bambu', 'Defne Medya', 'Zeytin Yazılım']);
  });

  it('durum filtreleri ve diğer adlarla arama', () => {
    expect(names(filterDirectory(all, { query: '', filter: 'yeni-ilan', sort: 'ad' }))).toEqual(['Defne Medya']);
    expect(names(filterDirectory(all, { query: '', filter: 'basvurmadim', sort: 'ad' }))).toEqual(['Bambu']);
    expect(names(filterDirectory(all, { query: 'ajans', filter: 'tum', sort: 'ad' }))).toEqual(['Defne Medya']);
  });

  it('görünüm adres çubuğunda; varsayılanlar yazılmaz', () => {
    expect(writeView(new URLSearchParams(), { query: '', filter: 'tum', sort: 'son-basvuru' }).toString()).toBe('');
    const written = writeView(new URLSearchParams(), { query: 'defne', filter: 'yanit-var', sort: 'ad' });
    expect(parseView(written)).toEqual({ query: 'defne', filter: 'yanit-var', sort: 'ad' });
    expect(parseView(new URLSearchParams('durum=bilinmeyen'))).toMatchObject({ filter: 'tum' });
  });

  it('son başvuru metni ve başvuru durumu', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    expect(lastApplyText('2026-10-29T12:00:00Z', now)).toBe('12 gün önce başvuruldu');
    expect(lastApplyText(null, now)).toBeNull();
    expect(applicationStatus({ state: 'provider_accepted', outcome: null, replyCount: 1 }).label).toBe('Yanıt geldi');
    expect(applicationStatus({ state: 'provider_accepted', outcome: 'interview', replyCount: 1 }).label).toBe('Görüşme');
  });
});
