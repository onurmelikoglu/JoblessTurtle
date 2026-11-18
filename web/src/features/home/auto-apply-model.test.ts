import { describe, expect, it } from 'vitest';
import type { AutoApplySettings } from '@/api/types';
import { dailySearches, formOf, formProblems, intervalLabel, queriesPerRun, toggled } from './auto-apply-model';

const settings: AutoApplySettings = {
  autoSend: true,
  dailyLimit: 10,
  searchEveryHours: 24,
  filterCities: [],
  filterWorkModes: [],
  filterSizes: [],
  includeUnknownWorkMode: true,
  includeUnknownSize: true,
  fMin: 85,
  qMin: 65,
  coverageMin: 0.6,
  companyCooldownDays: 30,
  atsAutoImprove: true,
  atsThreshold: 70,
  atsRewriteMode: 'fill_gaps',
  atsCvLayout: 'original',
  atsMaxPages: 1,
};

describe('otomatik başvuru ayarları', () => {
  it('arama aralığına göre sorgu ve günlük arama sayısı', () => {
    expect([2, 4, 8, 12, 24].map(queriesPerRun)).toEqual([1, 1, 2, 2, 4]);
    expect([2, 4, 8, 12, 24].map(dailySearches)).toEqual([12, 6, 6, 4, 4]);
    expect(intervalLabel(24)).toBe('Günde bir');
    expect(intervalLabel(4)).toBe('4 saatte bir');
  });

  it('form otomatik gönderim anahtarını taşımaz; sorunlar kaydetmeden önce söylenir', () => {
    const form = formOf(settings);
    expect('autoSend' in form).toBe(false);
    expect(formProblems(form)).toEqual([]);
    expect(formProblems({ ...form, dailyLimit: 0 })).toEqual(['Günlük başvuru sayısı 1 ile 100 arasında olmalı']);
    expect(formProblems({ ...form, filterWorkModes: ['onsite', 'hybrid', 'remote'] })).toHaveLength(1);
  });

  it('seçim aç/kapa', () => {
    expect(toggled(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggled(['a', 'b'], 'a')).toEqual(['b']);
  });
});
