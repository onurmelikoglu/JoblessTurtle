import { CirclePause, Hourglass, Radar, RefreshCw, ServerOff, TriangleAlert } from 'lucide-react';
import { homeApi } from '@/api/home';
import { useAction } from '@/api/queries';
import type { ActivityStatus, HomeActivity, HomeState } from '@/api/types';
import { fmtAgo, fmtUntil } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { useConfirm } from '@/ui/confirm-context';
import { Switch } from '@/ui/fields';
import { Panel } from '@/ui/Panel';
import { Spinner } from '@/ui/Spinner';
import { Tip } from '@/ui/Tip';
import { aiNotice } from './model';

const STATUS_TITLE: Record<ActivityStatus, string> = { working: 'Çalışıyor', idle: 'Beklemede', paused: 'Arama durduruldu', waiting_ai: 'AI hakkı bekleniyor' };

function StatusIcon({ status }: { status: ActivityStatus }) {
  const frame = 'flex size-10 shrink-0 items-center justify-center rounded-full';
  if (status === 'working') {
    return (
      <span className={`${frame} bg-brand-soft text-brand`}>
        <Spinner className="size-5" label="Çalışıyor" />
      </span>
    );
  }
  if (status === 'paused') return <CirclePause className={`${frame} bg-neutral-soft p-2.5 text-ink-soft`} aria-hidden />;
  if (status === 'waiting_ai') return <Hourglass className={`${frame} bg-warn-soft p-2.5 text-warn`} aria-hidden />;
  return <Radar className={`${frame} bg-brand-soft p-2.5 text-brand`} aria-hidden />;
}

function scanLine(activity: HomeActivity): string {
  if (activity.sources === 0) return activity.companies === 0 ? 'Henüz arama yapılmadı.' : 'Takip edilen kariyer sayfası yok; yeni firmalar keşfedildikçe eklenir.';
  const parts = [`Otomatik takip açık: ${activity.sources} kaynak düzenli aralıklarla taranıyor${activity.routineCrawls ? ` (şu an ${activity.routineCrawls} tarama)` : ''}`];
  if (activity.lastScanAt) parts.push(`son tarama ${fmtAgo(activity.lastScanAt)}`);
  if (activity.nextScanAt) parts.push(`sıradaki ${fmtUntil(activity.nextScanAt)}`);
  return `${parts.join(' · ')}.`;
}

function backlogLine(activity: HomeActivity): string | null {
  const { letters, lettersReady, waitingForBudget } = activity.backlog;
  const parts: string[] = [];
  if (letters > 0) {
    if (activity.status === 'paused') parts.push(`${letters} firmanın yazısı arama yeniden başlayınca hazırlanacak`);
    else if (waitingForBudget) parts.push(`${letters} firmanın yazısı AI hakkı yenilenince hazırlanacak`);
    else parts.push(`${letters} firmanın yazısı arka planda sırayla hazırlanacak${activity.nextPrepAt ? ` (sıradaki tur ${fmtUntil(activity.nextPrepAt)})` : ''}`);
  }
  if (lettersReady > 0) parts.push(`${lettersReady} yazı hazır; kontrol edip gönderebilirsin`);
  return parts.length ? `${parts.join(' · ')}.` : null;
}

function Stat({ label, short, value }: { label: string; short: string; value: number }) {
  return (
    <div className="flex min-w-0 flex-col-reverse">
      <dt className="truncate text-[11px] text-ink-soft sm:text-xs">
        <span className="sm:hidden">{short}</span>
        <span className="max-sm:hidden">{label}</span>
      </dt>
      <dd className="text-lg font-semibold tabular-nums sm:text-xl">{value}</dd>
    </div>
  );
}

export interface HomeStats {
  companies: number;
  matchingJobs: number;
  applications: number;
  replies: number;
}

interface StatusPanelProps {
  state: HomeState;
  stats: HomeStats;
}

/** Arka planda gerçekten ne olduğunu gösterir: çalışan iş varsa hangisi, yoksa sıradaki otomatik işin ne zaman olduğu. */
export function StatusPanel({ state, stats }: StatusPanelProps) {
  const { activity, autoApply, ai, setup } = state;
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const mailMissing = setup.missing.includes('mail');
  const notice = aiNotice(ai);
  const backlog = backlogLine(activity);
  const activeCount = activity.items.reduce((n, item) => n + item.running, 0);

  const stop = async () => {
    const ok = await confirm({
      title: 'Arama durdurulsun mu?',
      message: 'Sıradaki firma keşfi, analiz, mail adresi araması ve yazı hazırlama işleri iptal edilir; şu an çalışan bir iki iş tamamlanır. Otomatik günlük arama da sen "Yeniden ara" diyene kadar durur. Gönderim kuyruğu ve mail dönüşü takibi etkilenmez.',
      confirmLabel: 'Durdur',
      danger: true,
    });
    if (ok) await run(homeApi.stopSearch, { success: 'Arama durduruldu' });
  };

  return (
    <Panel className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <StatusIcon status={activity.status} />
        <div className="min-w-0 flex-1 basis-72" aria-live="polite">
          <p className="font-semibold">{STATUS_TITLE[activity.status]}</p>
          {activity.items.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {activity.items.map((item) => (
                <li key={item.kind}>
                  <Badge tone={item.running > 0 ? 'info' : 'neutral'}>
                    {item.label}: {[item.running > 0 && `${item.running} çalışıyor`, item.queued > 0 && `${item.queued} sırada`].filter(Boolean).join(', ')}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-1.5 flex flex-col gap-1 text-sm text-ink-soft">
            {activity.status === 'paused' ? (
              <p>{activeCount > 0 ? `Çalışan ${activeCount} iş tamamlanıyor. ` : ''}Otomatik takip ve günlük keşif durdu; devam etmek için "Yeniden ara"ya bas.</p>
            ) : (
              <>
                <p>{scanLine(activity)}</p>
                {activity.nextDiscoveryAt && <p>Yeni firma keşfi: {fmtUntil(activity.nextDiscoveryAt)}.</p>}
              </>
            )}
            {backlog && <p>{backlog}</p>}
            {notice && (
              <p className="flex items-start gap-1.5 text-warn">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                {notice}
              </p>
            )}
            {!activity.workerOnline && (
              <p className="flex items-start gap-1.5 text-bad">
                <ServerOff className="mt-0.5 size-4 shrink-0" aria-hidden />
                Arka plan servisi yanıt vermiyor; arama, yazı hazırlama ve gönderim şu an ilerlemiyor.
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Tip label={mailMissing ? 'Önce Profilim sayfasından mail hesabını bağla.' : autoApply.autoSend ? 'Açık: uygun firmalara mesai saatlerinde kendisi başvurur.' : 'Kapalı: yazıları hazırlar, sen onaylayınca gönderir.'}>
            <span>
              <Switch
                label="Otomatik başvur"
                checked={autoApply.autoSend}
                disabled={busy || mailMissing}
                onChange={(enabled) => run(() => homeApi.setAutoSend(enabled), { success: enabled ? 'Otomatik başvuru açıldı' : 'Otomatik başvuru kapandı; yazılar onayına sunulacak' })}
              />
            </span>
          </Tip>
          <div className="flex gap-2">
            {activity.status !== 'paused' && (
              <Button variant="outline" size="sm" icon={<CirclePause className="size-4" aria-hidden />} disabled={busy} onClick={stop}>
                Durdur
              </Button>
            )}
            <Button variant={activity.status === 'paused' ? 'primary' : 'outline'} size="sm" icon={<RefreshCw className="size-4" aria-hidden />} disabled={busy} onClick={() => run(homeApi.search, { success: 'Arama başlatıldı; ilerlemeyi buradan izleyebilirsin' })}>
              Yeniden ara
            </Button>
          </div>
        </div>
      </div>
      <dl className="grid grid-cols-4 gap-x-3 border-t border-line pt-3 sm:gap-x-4 sm:pt-4">
        <Stat label="Başvurmadığım firma" short="Firma" value={stats.companies} />
        <Stat label="Eşleşen açık ilan" short="Eşleşen ilan" value={stats.matchingJobs} />
        <Stat label="Başvuru" short="Başvuru" value={stats.applications} />
        <Stat label="Firma yanıtı" short="Yanıt" value={stats.replies} />
      </dl>
    </Panel>
  );
}
