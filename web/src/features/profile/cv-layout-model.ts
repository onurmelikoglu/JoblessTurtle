import type { CvLayoutState, HomeCvLayout } from '@/api/types';
import type { Tone } from '@/ui/tones';

const STATE_TEXT: Record<CvLayoutState, { label: string; tone: Tone }> = {
  ready: { label: 'Şablon hazır', tone: 'good' },
  preparing: { label: 'Hazırlanıyor…', tone: 'info' },
  failed: { label: 'Oluşturulamadı', tone: 'bad' },
  none: { label: 'Henüz hazırlanmadı', tone: 'neutral' },
  unsupported: { label: 'Bu sunucuda kullanılamıyor', tone: 'warn' },
};

export function layoutBadge(state: CvLayoutState) {
  return STATE_TEXT[state];
}

export function layoutDetail(layout: HomeCvLayout): string {
  switch (layout.state) {
    case 'ready':
      return layout.usesPhoto ? 'Fotoğraf, renkler ve bölüm düzeni orijinal CV’den alındı.' : 'Renkler ve bölüm düzeni orijinal CV’den alındı; fotoğraf bulunamadı.';
    case 'preparing':
      return 'Yapay zekâ CV’nin tasarımını şablona aktarıyor; birkaç dakika sürebilir.';
    case 'failed':
      return `İyileştirilen CV şimdilik sade ATS şablonuyla hazırlanır${layout.reason ? ` (${layout.reason})` : ''}.`;
    case 'none':
      return 'İlk iyileştirmede kendiliğinden hazırlanır; istersen şimdi hazırlatabilirsin.';
    case 'unsupported':
      return 'PDF çizici (Chromium) kurulu olmadığından sade ATS şablonu kullanılır.';
  }
}

export function canRebuild(state: CvLayoutState): boolean {
  return state !== 'preparing' && state !== 'unsupported';
}
