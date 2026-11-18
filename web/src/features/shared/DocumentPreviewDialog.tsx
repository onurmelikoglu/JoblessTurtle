import { useQuery } from '@tanstack/react-query';
import { Download, ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { homeApi } from '@/api/home';
import type { HomeAtsItem } from '@/api/types';
import { variantLabel, atsTone } from '@/features/home/ats-model';
import { openBlob, saveBlob } from '@/lib/download';
import { fmtBytes } from '@/lib/format';
import { loadPdf, renderPage } from '@/lib/pdf-render';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { LoadError, LoadingBlock } from '@/ui/feedback';
import { Notice } from '@/ui/Notice';
import { documentLabel } from './documents';
import { MAX_PREVIEW_PAGES, pagesNote, previewKind } from './document-preview';

export interface PreviewDocument {
  id: string;
  fileName: string;
  mime?: string;
  type: string;
  size?: number;
  language?: string;
  variant?: string;
}

function PdfPages({ blob }: { blob: Blob }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; pages: number }>({ status: 'loading', pages: 0 });

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => Promise<void>) | null = null;
    const draw = async () => {
      const loaded = await loadPdf(await blob.arrayBuffer());
      destroy = loaded.destroy;
      const { doc } = loaded;
      const target = host.current;
      if (cancelled || !target) return;
      target.replaceChildren();
      const width = target.clientWidth;
      for (let page = 1; page <= Math.min(doc.numPages, MAX_PREVIEW_PAGES); page++) {
        if (cancelled) return;
        const canvas = document.createElement('canvas');
        canvas.className = 'block h-auto w-full rounded-md bg-white shadow-sm ring-1 ring-line';
        canvas.setAttribute('aria-label', `Sayfa ${page}`);
        target.append(canvas);
        await renderPage(doc, page, canvas, width);
      }
      if (!cancelled) setState({ status: 'ready', pages: doc.numPages });
    };
    draw().catch(() => !cancelled && setState({ status: 'error', pages: 0 }));
    return () => {
      cancelled = true;
      void destroy?.();
    };
  }, [blob]);

  return (
    <div className="flex flex-col gap-2">
      {state.status === 'loading' && <LoadingBlock label="Sayfalar hazırlanıyor…" />}
      {state.status === 'error' && <Notice tone="warn">PDF burada gösterilemedi. "İndir" ile açabilirsin.</Notice>}
      {state.status === 'ready' && <p className="text-xs text-ink-soft">{pagesNote(state.pages)}</p>}
      <div ref={host} className="flex flex-col gap-3" />
    </div>
  );
}

function ImagePreview({ blob, alt }: { blob: Blob; alt: string }) {
  const [url] = useState(() => URL.createObjectURL(blob));
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img src={url} alt={alt} className="h-auto w-full rounded-md ring-1 ring-line" />;
}

function AtsSummary({ item, threshold }: { item: HomeAtsItem; threshold: number }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-sunken/40 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={atsTone(item.score, threshold)}>ATS %{item.score}</Badge>
        <span className="text-ink-soft">bu ilana göre · eşik %{threshold}</span>
      </div>
      {item.addedSkills.length > 0 && (
        <p>
          <span className="font-medium">İyileştirmede kanıtı olmadan eklenenler:</span> {item.addedSkills.join(', ')}
        </p>
      )}
      {item.missing.length > 0 && (
        <p className="text-ink-soft">
          <span className="font-medium">İlanda istenip CV'de hâlâ olmayanlar:</span> {item.missing.join(', ')}
        </p>
      )}
    </div>
  );
}

interface DocumentPreviewDialogProps {
  doc: PreviewDocument;
  /** Belgenin bu ilana ATS oranı (başvuru önizlemesinden açılınca). */
  ats?: { item: HomeAtsItem; threshold: number } | null;
  /** Dosya kayıtlı belge yerine başka bir kaynaktan gelir (ör. CV şablonunun deneme çizimi). */
  source?: { key: string; load: () => Promise<Blob>; note: string };
  onClose: () => void;
}

/**
 * Maile eklenecek ya da eklenmiş dosyayı uygulamanın içinde gösterir: PDF sayfaları telefonda da çizilir, görseller
 * olduğu gibi açılır. ATS sürümlerinde oran, eklenen ve eksik kalan terimler sayfaların üstünde görünür.
 */
export function DocumentPreviewDialog({ doc, ats, source, onClose }: DocumentPreviewDialogProps) {
  const file = useQuery({
    queryKey: source ? ['document-preview', source.key] : ['document-file', doc.id],
    queryFn: source ? source.load : () => homeApi.downloadDocument(doc.id),
    staleTime: 0,
    gcTime: 0,
  });
  const kind = previewKind(doc.mime, doc.fileName);
  const kindLabel = doc.type === 'cv' && doc.variant && doc.variant !== 'original' ? variantLabel(doc.variant) : documentLabel(doc.type);
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={doc.fileName}
      description={[kindLabel, doc.language === 'en' && 'İngilizce', doc.size !== undefined && fmtBytes(doc.size), source ? source.note : 'mailde bu dosya gider'].filter(Boolean).join(' · ')}
      footer={
        file.data && (
          <>
            {kind !== 'other' && (
              <Button variant="ghost" icon={<ExternalLink className="size-4" aria-hidden />} onClick={() => openBlob(file.data!)}>
                Yeni sekmede aç
              </Button>
            )}
            <Button variant="primary" icon={<Download className="size-4" aria-hidden />} onClick={() => saveBlob(file.data!, doc.fileName)}>
              İndir
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {ats && <AtsSummary item={ats.item} threshold={ats.threshold} />}
        {file.isError ? (
          <LoadError label="Dosya" onRetry={() => void file.refetch()} />
        ) : !file.data ? (
          <LoadingBlock label="Dosya yükleniyor…" />
        ) : kind === 'pdf' ? (
          <PdfPages blob={file.data} />
        ) : kind === 'image' ? (
          <ImagePreview blob={file.data} alt={doc.fileName} />
        ) : (
          <Notice tone="info">Bu dosya türü burada gösterilemiyor; "İndir" ile bilgisayarında açabilirsin.</Notice>
        )}
      </div>
    </Dialog>
  );
}
