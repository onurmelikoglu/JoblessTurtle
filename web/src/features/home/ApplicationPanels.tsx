import { CalendarClock, RefreshCw } from 'lucide-react';
import type { HomeApplication, SendQueueSummary } from '@/api/types';
import { cn } from '@/lib/cn';
import { fmtTime, toDate } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { Button } from '@/ui/Button';
import { FilterChip } from '@/ui/controls';
import { ProgressBar } from '@/ui/feedback';
import { Panel, PanelTitle } from '@/ui/Panel';
import { TONE_FILL, TONE_TEXT } from '@/ui/tones';
import { BUCKET_INFO, BUCKET_ORDER, bucketCounts, type DeliveryBucket } from './model';

export function SendQueuePanel({ queue, busy, onRetry }: { queue: SendQueueSummary; busy: boolean; onRetry: () => void }) {
  const now = useNow();
  const finish = toDate(queue.estimatedFinishAt);
  const minutesLeft = finish ? Math.max(1, Math.ceil((finish.getTime() - now) / 60_000)) : null;
  const sendingToday = queue.remaining > queue.deferredToTomorrow;
  return (
    <Panel className="flex flex-col gap-3">
      <PanelTitle
        icon={<CalendarClock className="size-5 text-ink-soft" aria-hidden />}
        action={
          <Button variant="ghost" size="sm" disabled={busy} icon={<RefreshCw className="size-4" aria-hidden />} onClick={onRetry}>
            Bekleyenleri tekrar dene
          </Button>
        }
      >
        Gönderim kuyruğu: {queue.sent} / {queue.total} gönderildi
      </PanelTitle>
      <ProgressBar value={queue.total === 0 ? null : queue.sent / queue.total} />
      <p className="text-sm text-ink-soft">
        {queue.remaining} mail sırada; mailler arasında 30-50 sn bekleniyor
        {sendingToday && minutesLeft !== null ? ` · tahmini bitiş ${fmtTime(queue.estimatedFinishAt)} (yaklaşık ${minutesLeft} dk)` : ''}
      </p>
      {queue.deferredToTomorrow > 0 && (
        <p className="text-sm text-warn">
          {queue.deferredToTomorrow} mail günlük gönderim limiti ({queue.dailyLimit ?? '-'}) nedeniyle ertesi sabah 09:00'da gidecek. Limiti Profilim'den artırabilirsin.
        </p>
      )}
    </Panel>
  );
}

interface ApplicationSummaryProps {
  applications: HomeApplication[];
  active: DeliveryBucket | null;
  onSelect: (bucket: DeliveryBucket | null) => void;
}

/** Başvuruların teslim durumuna göre özeti; çipler aynı zamanda listeyi süzer. */
export function ApplicationSummary({ applications, active, onSelect }: ApplicationSummaryProps) {
  const { counts, successful, counted } = bucketCounts(applications);
  const failed = counts.failed + counts.notSent;
  const segments: [number, keyof typeof TONE_FILL][] = [
    [successful, 'good'],
    [counts.redirect, 'warn'],
    [failed, 'bad'],
  ];
  const notes = [failed > 0 && `${failed} iletilemedi`, counts.redirect > 0 && `${counts.redirect} firmada başka kanal istendi`, counts.resent > 0 && `${counts.resent} düzeltilip tekrar gönderildi`, counts.queued > 0 && `${counts.queued} sırada`].filter(Boolean);
  return (
    <Panel className="flex flex-col gap-3">
      <p className="text-base">
        <span className={cn('text-2xl font-bold tabular-nums', TONE_TEXT.good)}>{successful}</span> / {counted} başvuru yerine ulaştı
      </p>
      {counted > 0 && (
        <div className="flex h-2.5 overflow-hidden rounded-full bg-neutral-soft" aria-hidden>
          {segments.map(([n, tone]) => (n > 0 ? <div key={tone} className={TONE_FILL[tone]} style={{ flexGrow: n }} /> : null))}
        </div>
      )}
      {notes.length > 0 && <p className="text-sm text-ink-soft">{notes.join(' · ')}</p>}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Teslim durumuna göre süz">
        <FilterChip active={active === null} onToggle={() => onSelect(null)} count={applications.length}>
          Tümü
        </FilterChip>
        {BUCKET_ORDER.filter((bucket) => counts[bucket] > 0).map((bucket) => (
          <FilterChip key={bucket} active={active === bucket} onToggle={() => onSelect(active === bucket ? null : bucket)} count={counts[bucket]} title={BUCKET_INFO[bucket].hint}>
            {BUCKET_INFO[bucket].label}
          </FilterChip>
        ))}
      </div>
      {active && <p className="text-sm text-ink-soft">{BUCKET_INFO[active].hint}</p>}
    </Panel>
  );
}
