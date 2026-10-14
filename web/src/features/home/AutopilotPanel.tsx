import { Bot, Check, ChevronDown, ChevronUp, CircleAlert, Info, Send, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { homeApi } from '@/api/home';
import { useAction } from '@/api/queries';
import type { AutopilotActionItem, AutopilotOverview, HomeAi } from '@/api/types';
import { cn } from '@/lib/cn';
import { fmtAgo } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { useConfirm } from '@/ui/confirm-context';
import { InlineBusy } from '@/ui/feedback';
import { Panel, PanelTitle } from '@/ui/Panel';
import { TONE_TEXT } from '@/ui/tones';
import { aiUsageLine, approvableActions, loggedActions, MODE_INFO, pipelineSteps, retryLabel, STATE_INFO, waitingActions } from './autopilot-model';

const LOG_PREVIEW = 6;
const LOG_ICON = { executed: Send, info: Info, failed: CircleAlert } as const;

function Pipeline({ overview }: { overview: AutopilotOverview }) {
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-2 border-y border-line py-3">
      {pipelineSteps(overview.pipeline).map((step) => (
        <div key={step.key} className="flex min-w-16 flex-col-reverse">
          <dt className="text-xs text-ink-soft">{step.label}</dt>
          <dd className={cn('text-lg font-semibold tabular-nums', step.tone !== 'neutral' && TONE_TEXT[step.tone])}>{step.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface WaitingRowProps {
  action: AutopilotActionItem;
  busy: boolean;
  onApprove: () => void;
  onDismiss: () => void;
}

function WaitingRow({ action, busy, onApprove, onDismiss }: WaitingRowProps) {
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-64 text-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h4 className="font-semibold">{action.company}</h4>
          <Badge tone="bad">{action.label}</Badge>
          {action.toEmail && <span className="break-all text-ink-soft">→ {action.toEmail}</span>}
        </div>
        <p className="mt-1 break-words">{action.detail}</p>
        {action.usesAi && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-soft">
            <Sparkles className="size-3.5" aria-hidden />
            Onaylarsan yapay zekâ kullanılır; işlem birkaç dakika sürebilir.
          </p>
        )}
      </div>
      {action.state === 'running' ? (
        <InlineBusy>Uygulanıyor…</InlineBusy>
      ) : (
        <div className="flex gap-2">
          <Button variant="tonal" size="sm" disabled={busy} icon={<Check className="size-4" aria-hidden />} onClick={onApprove}>
            Onayla
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} icon={<X className="size-4" aria-hidden />} onClick={onDismiss}>
            Vazgeç
          </Button>
        </div>
      )}
    </li>
  );
}

function LogRow({ action, now }: { action: AutopilotActionItem; now: number }) {
  const Icon = LOG_ICON[action.state as keyof typeof LOG_ICON] ?? Info;
  const state = STATE_INFO[action.state];
  const retry = retryLabel(action.retry, now);
  const meta = [fmtAgo(action.executedAt ?? action.createdAt, now), action.approved && 'onayınla', retry && `yeniden gönderim: ${retry}`, action.aiTasks > 0 && `${action.aiTasks} yapay zekâ görevi`].filter(Boolean);
  return (
    <li className="flex items-start gap-2 py-2 text-sm">
      <Icon className={cn('mt-0.5 size-4 shrink-0', TONE_TEXT[state.tone])} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="break-words">
          <span className="font-medium">{action.company}</span>
          {action.state === 'executed' && action.toEmail ? ` → ${action.toEmail}` : ''} <span className="text-ink-soft">· {action.label}</span>
        </p>
        <p className="break-words text-ink-soft">{action.detail}</p>
        <p className={cn('text-xs', action.retry?.state === 'bounced' ? 'text-bad' : 'text-ink-faint')}>{meta.join(' · ')}</p>
      </div>
    </li>
  );
}

/**
 * Otopilot: geri dönen başvurular için verilen kararlar. Üstte zincirin durumu, ortada onay bekleyen öneriler,
 * altta yapılanların günlüğü ve günün yapay zekâ harcaması yer alır.
 */
export function AutopilotPanel({ overview, ai }: { overview: AutopilotOverview; ai: HomeAi }) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const now = useNow();
  const [showAll, setShowAll] = useState(false);
  const mode = MODE_INFO[overview.mode];
  const waiting = waitingActions(overview.actions);
  const approvable = approvableActions(overview.actions);
  const log = loggedActions(overview.actions);
  const usage = aiUsageLine(ai.classes);

  const approve = (ids: string[]) => run(() => homeApi.approveAutopilot(ids), { success: (r) => (r.queued > 0 ? `${r.queued} düzeltme uygulanıyor` : null) });
  const dismiss = (ids: string[]) => run(() => homeApi.dismissAutopilot(ids));
  const approveAll = async () => {
    const withAi = approvable.filter((a) => a.usesAi).length;
    const ok = await confirm({
      title: `${approvable.length} öneri onaylansın mı?`,
      message: `Her öneri açıklamasında yazdığı şekilde uygulanır ve gönderimler normal kuyrukla (30-50 sn arayla) gider.${withAi > 0 ? ` ${withAi} öneride yapay zekâ kullanılacak (yeni adres araması ya da yazının düzeltilmesi).` : ''}`,
      confirmLabel: 'Onayla',
    });
    if (ok) await approve(approvable.map((a) => a.id));
  };

  return (
    <Panel className="flex flex-col gap-3">
      <PanelTitle icon={<Bot className="size-5 text-ink-soft" aria-hidden />} action={<Badge tone={mode.tone}>{mode.label}</Badge>}>
        Otopilot
      </PanelTitle>
      <p className="text-sm text-ink-soft">{mode.text}</p>
      <Pipeline overview={overview} />
      {waiting.length > 0 && (
        <section aria-label="Onay bekleyen öneriler">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="mr-auto text-sm font-semibold">Onayını bekleyenler ({approvable.length})</h3>
            {approvable.length > 1 && (
              <Button variant="primary" size="sm" disabled={busy} icon={<Check className="size-4" aria-hidden />} onClick={approveAll}>
                Tümünü onayla
              </Button>
            )}
          </div>
          {mode.pendingHint && <p className="mt-0.5 text-xs text-ink-soft">{mode.pendingHint}</p>}
          <ul className="divide-y divide-line">
            {waiting.map((action) => (
              <WaitingRow key={action.id} action={action} busy={busy} onApprove={() => approve([action.id])} onDismiss={() => dismiss([action.id])} />
            ))}
          </ul>
        </section>
      )}
      {log.length > 0 && (
        <section aria-label="Otopilot günlüğü">
          <h3 className="text-sm font-semibold">Son yapılanlar</h3>
          <ul className="divide-y divide-line">
            {(showAll ? log : log.slice(0, LOG_PREVIEW)).map((action) => (
              <LogRow key={action.id} action={action} now={now} />
            ))}
          </ul>
          {log.length > LOG_PREVIEW && (
            <Button variant="ghost" size="sm" aria-expanded={showAll} icon={showAll ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />} onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Daha az göster' : `Tümünü göster (${log.length})`}
            </Button>
          )}
        </section>
      )}
      {waiting.length === 0 && log.length === 0 && <p className="text-sm text-ink-soft">Henüz düzeltilecek bir dönüş olmadı. Başvurularından biri geri dönerse yapılanlar burada görünür.</p>}
      {usage && <p className="text-xs text-ink-faint">{usage}</p>}
    </Panel>
  );
}
