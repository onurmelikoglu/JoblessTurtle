import { describe, expect, it } from 'vitest';
import { pagesNote, previewKind } from './document-preview';

describe('ek önizleme', () => {
  it('PDF ve görseller uygulama içinde, diğerleri indirilerek açılır', () => {
    expect(previewKind('application/pdf')).toBe('pdf');
    expect(previewKind('image/png')).toBe('image');
    expect(previewKind('image/svg+xml')).toBe('other');
    expect(previewKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('other');
    expect(previewKind(undefined, 'Portfolyo 2026.PDF')).toBe('pdf');
    expect(previewKind(undefined, 'cv.docx')).toBe('other');
  });

  it('uzun belgede gösterilen sayfa sınırı belirtilir', () => {
    expect(pagesNote(2)).toBe('2 sayfa');
    expect(pagesNote(40)).toBe("40 sayfanın ilk 12'si gösteriliyor");
  });
});
