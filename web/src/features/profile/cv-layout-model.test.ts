import { describe, expect, it } from 'vitest';
import type { HomeCvLayout } from '@/api/types';
import { canRebuild, layoutBadge, layoutDetail } from './cv-layout-model';

const layout = (patch: Partial<HomeCvLayout>): HomeCvLayout => ({ documentId: 'd1', fileName: 'cv.pdf', language: 'tr', state: 'ready', usesPhoto: true, reason: null, createdAt: null, ...patch });

describe('CV şablonu durumu', () => {
  it('hazır şablonda fotoğrafın alınıp alınmadığını söyler', () => {
    expect(layoutDetail(layout({}))).toContain('Fotoğraf');
    expect(layoutDetail(layout({ usesPhoto: false }))).toContain('fotoğraf bulunamadı');
  });

  it('başarısız şablonda nedeni ve sade şablona düşüldüğünü gösterir', () => {
    expect(layoutDetail(layout({ state: 'failed', reason: 'deneyimler şablondan gelmiyor' }))).toBe('İyileştirilen CV şimdilik sade ATS şablonuyla hazırlanır (deneyimler şablondan gelmiyor).');
    expect(layoutBadge('failed').tone).toBe('bad');
  });

  it('hazırlanırken ya da çizici yokken yeniden oluşturma sunulmaz', () => {
    expect(canRebuild('preparing')).toBe(false);
    expect(canRebuild('unsupported')).toBe(false);
    expect(canRebuild('failed')).toBe(true);
    expect(canRebuild('ready')).toBe(true);
  });
});
