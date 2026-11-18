export type PreviewKind = 'pdf' | 'image' | 'other';

export const MAX_PREVIEW_PAGES = 12;

/** Tür bilinmiyorsa (profildeki yükleme satırı) dosya uzantısına bakılır. */
export function previewKind(mime: string | undefined, fileName = ''): PreviewKind {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (mime === 'application/pdf' || (!mime && ext === 'pdf')) return 'pdf';
  if (/^image\/(png|jpe?g|webp|gif)$/.test(mime ?? '') || (!mime && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext))) return 'image';
  return 'other';
}

/** "3 sayfa" ya da uzun belgede "40 sayfanın ilk 12'si gösteriliyor". */
export function pagesNote(total: number): string {
  return total > MAX_PREVIEW_PAGES ? `${total} sayfanın ilk ${MAX_PREVIEW_PAGES}'si gösteriliyor` : `${total} sayfa`;
}
