import { useQuery } from '@tanstack/react-query';
import { Eye, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { homeApi } from '@/api/home';
import { useAction } from '@/api/queries';
import type { HomeCvLayout } from '@/api/types';
import { DocumentPreviewDialog } from '@/features/shared/DocumentPreviewDialog';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { SubSection } from './parts';
import { canRebuild, layoutBadge, layoutDetail } from './cv-layout-model';

const CV_LAYOUTS_QUERY = ['home', 'cv-layouts'] as const;
const PREPARING_POLL_MS = 15_000;

function LayoutRow({ layout, busy, onPreview, onRebuild }: { layout: HomeCvLayout; busy: boolean; onPreview: () => void; onRebuild: () => void }) {
  const badge = layoutBadge(layout.state);
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{layout.fileName}</span>
          <Badge tone="neutral">{layout.language === 'en' ? 'İngilizce' : 'Türkçe'}</Badge>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>
        <p className="text-xs text-ink-soft">{layoutDetail(layout)}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-1">
        {layout.state === 'ready' && (
          <Button variant="ghost" size="sm" icon={<Eye className="size-4" aria-hidden />} onClick={onPreview}>
            Önizle
          </Button>
        )}
        {canRebuild(layout.state) && (
          <Button variant="ghost" size="sm" disabled={busy} icon={<RefreshCw className="size-4" aria-hidden />} onClick={onRebuild}>
            {layout.state === 'ready' ? 'Yeniden oluştur' : 'Şimdi hazırla'}
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * Orijinal CV'lerin tasarım şablonları: iyileştirilen CV fotoğrafı, renkleri ve bölüm düzeniyle bu şablondan PDF'e
 * çevrilir. Önizleme şablonu orijinal metinle doldurup gösterir; benzemiyorsa yeniden oluşturulabilir.
 */
export function CvLayouts() {
  const layouts = useQuery({
    queryKey: CV_LAYOUTS_QUERY,
    queryFn: homeApi.cvLayouts,
    refetchInterval: (query) => (query.state.data?.some((l) => l.state === 'preparing') ? PREPARING_POLL_MS : false),
  });
  const { busy, run } = useAction();
  const [previewing, setPreviewing] = useState<HomeCvLayout | null>(null);
  if (!layouts.data?.length) return null;

  const rebuild = (layout: HomeCvLayout) =>
    run(() => homeApi.rebuildCvLayout(layout.documentId), { success: 'Şablon hazırlanıyor; bitince ATS CV’lerin de yeni görünümle güncellenir' }).then(() => layouts.refetch());

  return (
    <SubSection title="İyileştirilmiş CV görünümü" description="ATS için iyileştirilen CV, orijinal CV’nin tasarımıyla (fotoğraf, renkler, sütunlar, bölüm başlıkları) PDF olarak hazırlanır. Önizlemede şablonu orijinal metninle görürsün.">
      <ul className="divide-y divide-line">
        {layouts.data.map((layout) => (
          <LayoutRow key={layout.documentId} layout={layout} busy={busy} onPreview={() => setPreviewing(layout)} onRebuild={() => void rebuild(layout)} />
        ))}
      </ul>
      {previewing && (
        <DocumentPreviewDialog
          doc={{ id: previewing.documentId, fileName: previewing.fileName, mime: 'application/pdf', type: 'cv', language: previewing.language }}
          source={{ key: `layout:${previewing.documentId}:${previewing.createdAt ?? ''}`, load: () => homeApi.cvLayoutPreview(previewing.documentId), note: 'şablon, orijinal metinle' }}
          onClose={() => setPreviewing(null)}
        />
      )}
    </SubSection>
  );
}
