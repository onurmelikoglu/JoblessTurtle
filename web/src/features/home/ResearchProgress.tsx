import { Square } from 'lucide-react';
import type { ResearchBatchStatus } from '@/api/types';
import { Button } from '@/ui/Button';
import { foundSummary } from './model';

/** Toplu firma araştırmasının ilerlemesi: kaç firma bitti, neler bulundu, kaçı kotaya takılıp sonraya kaldı. */
export function ResearchProgress({ batch, busy, onCancel }: { batch: ResearchBatchStatus; busy: boolean; onCancel: () => void }) {
  const percent = batch.total ? Math.round((batch.finished / batch.total) * 100) : 0;
  const running = batch.status === 'running';
  return (
    <div className="flex min-w-0 flex-1 basis-72 flex-col gap-1.5" aria-live="polite">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">{running ? `Firmalar araştırılıyor: ${batch.finished}/${batch.total}` : `Araştırma bitti: ${batch.total} firma`}</span>
        <span className="text-ink-soft">{foundSummary(batch)}</span>
        {running && (
          <Button variant="ghost" size="sm" className="ml-auto" disabled={busy} icon={<Square className="size-3.5" aria-hidden />} onClick={onCancel}>
            Durdur
          </Button>
        )}
      </div>
      {running && (
        <div className="h-1.5 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Araştırma ilerlemesi">
          <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${percent}%` }} />
        </div>
      )}
      {(batch.deferred > 0 || batch.skipped > 0 || batch.noResult > 0) && (
        <p className="text-xs text-ink-soft">
          {[
            batch.deferred > 0 && `${batch.deferred} firma sonraya kaldı${batch.deferredNote ? ` (${batch.deferredNote})` : ''}`,
            batch.skipped > 0 && `${batch.skipped} firma yakın zamanda arandığı için atlandı`,
            batch.noResult > 0 && `${batch.noResult} firmada yeni bilgi bulunamadı`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </div>
  );
}
