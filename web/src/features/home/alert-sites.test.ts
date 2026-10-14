import { describe, expect, it } from 'vitest';
import type { IsoDate } from '@/api/types';
import { ALERT_SITES, alertSiteState, chosenTitles, orKeywords, toggled } from './alert-sites';

const url = (platform: string, titles: string[], city: string | null) => ALERT_SITES.find((s) => s.platform === platform)!.searchUrl({ titles, city });

describe('iş alarmı kurulumu', () => {
  it('birden çok pozisyon VEYA ile tek aramada birleşir', () => {
    expect(orKeywords(['Sosyal Medya Uzmanı'])).toBe('Sosyal Medya Uzmanı');
    expect(orKeywords(['Sosyal Medya Uzmanı', 'Social Media Specialist', 'SMM'])).toBe('"Sosyal Medya Uzmanı" OR "Social Media Specialist" OR SMM');
  });

  it('seçimi her sitenin arama adresine çevirir', () => {
    const both = ['Sosyal Medya Uzmanı', 'Social Media Specialist'];
    expect(url('LinkedIn', both, 'İstanbul')).toBe(`https://www.linkedin.com/jobs/search/?${new URLSearchParams({ keywords: '"Sosyal Medya Uzmanı" OR "Social Media Specialist"', location: 'İstanbul, Türkiye' })}`);
    expect(url('LinkedIn', ['Art Director'], null)).toBe('https://www.linkedin.com/jobs/search/?keywords=Art+Director&location=T%C3%BCrkiye');
    expect(url('Indeed', both, 'İzmir')).toBe(`https://tr.indeed.com/jobs?${new URLSearchParams({ q: '"Sosyal Medya Uzmanı" OR "Social Media Specialist"', l: 'İzmir' })}`);
    expect(url('Indeed', ['Art Director'], null)).toBe('https://tr.indeed.com/jobs?q=Art+Director');
  });

  it('Kariyer.net VEYA desteklemez; ilk seçilen pozisyonla ve şehirsiz açılır', () => {
    expect(url('Kariyer.net', ['Sosyal Medya Uzmanı', 'Social Media Specialist'], 'İstanbul')).toBe('https://www.kariyer.net/is-ilanlari?kw=Sosyal+Medya+Uzman%C4%B1');
    expect(ALERT_SITES.filter((s) => !s.supportsOr).map((s) => s.platform)).toEqual(['Kariyer.net']);
  });

  it('seçim profildeki sırayı izler, en az bir pozisyon seçili kalır', () => {
    const titles = ['A', 'B', 'C'];
    expect(chosenTitles(titles, new Set(['C', 'A']))).toEqual(['A', 'C']);
    expect(chosenTitles(titles, new Set(['silinmiş']))).toEqual(['A']);
    expect([...toggled(new Set(['A']), 'B')]).toEqual(['A', 'B']);
    expect([...toggled(new Set(['A', 'B']), 'A')]).toEqual(['B']);
    expect([...toggled(new Set(['A']), 'A')]).toEqual(['A']);
  });

  it('siteden alarm maili geldiyse alarm çalışıyor sayılır', () => {
    const sites = [{ platform: 'LinkedIn', mails: 3, lastAt: '2026-10-13T18:00:00.000Z' as IsoDate }];
    expect(alertSiteState('LinkedIn', sites)).toEqual({ kind: 'working', mails: 3, lastAt: '2026-10-13T18:00:00.000Z' });
    expect(alertSiteState('Kariyer.net', sites)).toEqual({ kind: 'none' });
  });
});
