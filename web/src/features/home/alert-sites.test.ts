import { describe, expect, it } from 'vitest';
import type { IsoDate } from '@/api/types';
import { ALERT_SITES, alertSiteState, searchLabel } from './alert-sites';

const url = (platform: string, title: string, city: string | null) => ALERT_SITES.find((s) => s.platform === platform)!.searchUrl({ title, city });

describe('iş alarmı kurulumu', () => {
  it('profildeki aramayı her sitenin arama adresine çevirir', () => {
    expect(url('Kariyer.net', 'Sosyal Medya Uzmanı', 'İstanbul')).toBe('https://www.kariyer.net/is-ilanlari?kw=Sosyal+Medya+Uzman%C4%B1');
    expect(url('LinkedIn', 'Sosyal Medya Uzmanı', 'İstanbul')).toBe('https://www.linkedin.com/jobs/search/?keywords=Sosyal+Medya+Uzman%C4%B1&location=%C4%B0stanbul%2C+T%C3%BCrkiye');
    expect(url('LinkedIn', 'Art Director', null)).toBe('https://www.linkedin.com/jobs/search/?keywords=Art+Director&location=T%C3%BCrkiye');
    expect(url('Indeed', 'Art Director', 'İzmir')).toBe('https://tr.indeed.com/jobs?q=Art+Director&l=%C4%B0zmir');
    expect(url('Indeed', 'Art Director', null)).toBe('https://tr.indeed.com/jobs?q=Art+Director');
  });

  it('siteden alarm maili geldiyse alarm çalışıyor sayılır', () => {
    const sites = [{ platform: 'LinkedIn', mails: 3, lastAt: '2026-10-13T18:00:00.000Z' as IsoDate }];
    expect(alertSiteState('LinkedIn', sites)).toEqual({ kind: 'working', mails: 3, lastAt: '2026-10-13T18:00:00.000Z' });
    expect(alertSiteState('Kariyer.net', sites)).toEqual({ kind: 'none' });
    expect(searchLabel({ title: 'Art Director', city: 'İzmir' })).toBe('Art Director · İzmir');
  });
});
