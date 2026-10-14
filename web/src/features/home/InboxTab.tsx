import { Bot, Check, CircleAlert, CircleHelp, Clock, EllipsisVertical, ExternalLink, Inbox, MailCheck, MessagesSquare, Pencil, RefreshCw, Route, Send, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { homeApi, type InboxStatus } from '@/api/home';
import { useAction, useRefreshHome } from '@/api/queries';
import type { AutopilotActionItem, HomeAi, HomeInbox, HomeInboxWithAutopilot, InboxItem, ResendManyResult } from '@/api/types';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtDateTime, toDate } from '@/lib/format';
import { LINK_PARAMS, withoutParams } from '@/notification-links';
import { Badge } from '@/ui/Badge';
import { Button, IconButton, LinkButton } from '@/ui/Button';
import { useConfirm } from '@/ui/confirm-context';
import { FilterChip, SearchInput } from '@/ui/controls';
import { Dialog } from '@/ui/Dialog';
import { EmptyState, InlineBusy, LoadingBlock } from '@/ui/feedback';
import { Checkbox, Switch } from '@/ui/fields';
import { Menu } from '@/ui/Menu';
import { Notice } from '@/ui/Notice';
import { Panel, PanelTitle } from '@/ui/Panel';
import { toast } from '@/ui/toast';
import { TONE_TEXT } from '@/ui/tones';
import { STATE_INFO } from './autopilot-model';
import { AutopilotPanel } from './AutopilotPanel';
import { filterInbox, INBOX_VIEW_LABELS, INBOX_VIEWS, inboxViewCounts, type InboxView } from './inbox-filters';
import { InboundMailDialog } from './InboundMailDialog';
import { JobAlertsPanel } from './JobAlertsPanel';
import { INBOX_GROUP_TONE } from './model';
import { ResendDialog } from './ResendDialog';

const GROUP_ICON = { failed: CircleAlert, action: Route, review: CircleHelp, pending: Clock, delivered: MailCheck, reply: MessagesSquare } as const;
const INFO_GROUPS = new Set(['delivered', 'pending']);
const STATUS_LABELS: Record<string, string> = { resolved: 'Çözüldü', ignored: 'Yok sayıldı', resent: 'Tekrar gönderildi' };
const RETRY_STATE_LABELS: Record<string, string> = { queued: 'sırada', sending: 'gönderiliyor', provider_accepted: 'gönderildi', bounced: 'yine geri döndü', blocked: 'engellendi', cancelled: 'gönderilmedi', failed_confirmed: 'gönderilemedi' };
/** Yeniden gönderim gerçekleşmediyse dönüş yeniden düzenlenip gönderilebilir. */
const RETRY_NOT_SENT: ReadonlySet<string> = new Set(['blocked', 'cancelled', 'failed_confirmed']);

const absoluteUrl = (url: string) => (url.startsWith('http') ? url : `https://${url}`);

function TrackingPanel({ inbox, busy, run }: { inbox: HomeInbox; busy: boolean; run: ReturnType<typeof useAction>['run'] }) {
  const supported = inbox.accounts.some((a) => a.supported);
  const enabled = inbox.accounts.some((a) => a.enabled);
  const running = inbox.accounts.some((a) => a.running);
  const synced = inbox.accounts.map((a) => toDate(a.syncedAt)).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
  const { counts } = inbox;
  return (
    <Panel className="flex flex-col gap-3">
      <PanelTitle icon={<Inbox className="size-5 text-ink-soft" aria-hidden />} action={supported && <Switch label="Takip" checked={enabled} disabled={busy} onChange={(next) => run(() => homeApi.setInboxEnabled(next), { success: next ? 'Gelen kutusu takibi açıldı' : 'Gelen kutusu takibi kapatıldı' })} />}>
        Mail dönüşleri
      </PanelTitle>
      <p className="text-sm text-ink-soft">
        {supported
          ? 'Gönderdiğin başvurulara dönen hata bildirimlerini, otomatik yanıtları ve firma yanıtlarını gelen kutundan 10 dakikada bir okur. Bunların dışında yalnızca iş sitelerinin gönderdiği ilan bildirimleri okunur; diğer maillerin okunup saklanmaz.'
          : 'Bu mail hesabı türünde gelen kutusu okunamıyor. Uygulama şifresiyle bağlanan hesaplarda (Gmail, Outlook vb.) çalışır.'}
      </p>
      {supported && enabled && (
        <div className="flex flex-wrap items-center gap-2">
          {counts.failed > 0 && <Badge tone="bad">{counts.failed} iletilemedi</Badge>}
          {counts.action > 0 && <Badge tone="warn">{counts.action} yönlendirme</Badge>}
          {counts.reply > 0 && <Badge tone="good">{counts.reply} firma yanıtı</Badge>}
          {counts.delivered > 0 && <Badge tone="info">{counts.delivered} ulaştı bildirimi</Badge>}
          {running ? <InlineBusy>Gelen kutusu kontrol ediliyor…</InlineBusy> : <span className="text-sm text-ink-soft">{synced ? `Son kontrol ${fmtAgo(synced)}` : 'Henüz kontrol edilmedi'}</span>}
          <Button variant="ghost" size="sm" disabled={busy || running} icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => run(homeApi.syncInbox, { success: 'Gelen kutusu kontrol ediliyor; sonuçlar birkaç dakika içinde gelir' })}>
            Şimdi kontrol et
          </Button>
        </div>
      )}
      {inbox.accounts
        .filter((a) => a.error)
        .map((a) => (
          <Notice key={a.id} tone="warn" icon={<TriangleAlert className="size-5 shrink-0" aria-hidden />}>
            {a.email}: {a.error}
          </Notice>
        ))}
      {inbox.items.length === 0 && enabled && synced && <p className="text-sm text-ink-soft">Başvurularına henüz bir dönüş gelmedi. Hata bildirimi gelmeyen mailler büyük ihtimalle yerine ulaştı.</p>}
    </Panel>
  );
}

function ResendSummaryDialog({ result, onClose }: { result: ResendManyResult; onClose: () => void }) {
  const skipped = result.results.filter((r) => r.status === 'skipped');
  return (
    <Dialog open onClose={onClose} title={`${result.queued} başvuru sıraya alındı`} footer={<Button onClick={onClose}>Tamam</Button>}>
      <ul className="flex flex-col gap-1 text-sm">
        {result.results
          .filter((r) => r.status === 'queued')
          .map((r) => (
            <li key={r.attemptId} className="flex items-start gap-2">
              <Check className="mt-0.5 size-4 shrink-0 text-good" aria-hidden />
              {r.company} → {r.toEmail}
            </li>
          ))}
      </ul>
      {skipped.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-semibold">Atlananlar ({skipped.length})</h3>
          <ul className="mt-1 list-disc pl-5 text-sm text-ink-soft">
            {skipped.map((r) => (
              <li key={r.attemptId}>
                {r.company}: {r.reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}

interface InboxRowProps {
  item: InboxItem;
  autopilot: AutopilotActionItem | undefined;
  selectable: boolean;
  selected: boolean;
  busy: boolean;
  onToggle: () => void;
  onResend: () => void;
  onShow: () => void;
  onStatus: (status: InboxStatus) => void;
}

function InboxRow({ item, autopilot, selectable, selected, busy, onToggle, onResend, onShow, onStatus }: InboxRowProps) {
  const tone = INBOX_GROUP_TONE[item.group] ?? 'neutral';
  const Icon = GROUP_ICON[item.group as keyof typeof GROUP_ICON] ?? Inbox;
  return (
    <li className="flex items-start gap-3 px-3 py-3 sm:px-4">
      <span className="flex size-9 shrink-0 items-center justify-center">{selectable ? <Checkbox checked={selected} onChange={onToggle} aria-label={`${item.company} seç`} /> : <Icon className={cn('size-5', TONE_TEXT[tone])} aria-hidden />}</span>
      <div className="min-w-0 flex-1 text-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="font-semibold">{item.company}</h3>
          <Badge tone={tone}>{item.label}</Badge>
          {STATUS_LABELS[item.status] && !INFO_GROUPS.has(item.group) && <Badge>{STATUS_LABELS[item.status]}</Badge>}
        </div>
        <p className="mt-0.5 break-words text-ink-soft">
          {fmtDateTime(item.receivedAt)} · gönderilen: {item.toEmail ?? '-'} · dönen: {item.fromEmail ?? '-'}
        </p>
        {item.reason && <p className="mt-1 break-words">{item.reason}</p>}
        {item.status === 'open' && item.hint && !autopilot && <p className="mt-0.5 text-ink-soft italic">{item.hint}</p>}
        {item.suggestedEmail && <p className="mt-0.5 font-medium">Önerilen adres: {item.suggestedEmail}</p>}
        {item.retry && (
          <p className={cn('mt-1', item.retry.state === 'bounced' || RETRY_NOT_SENT.has(item.retry.state) ? 'text-bad' : 'text-info')}>
            Tekrar gönderim: {item.retry.toEmail} · {RETRY_STATE_LABELS[item.retry.state] ?? item.retry.state}
          </p>
        )}
        {autopilot && (
          <p className="mt-1 flex items-start gap-1.5 text-ink-soft">
            <Bot className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">
              <span className={cn('font-medium', TONE_TEXT[STATE_INFO[autopilot.state].tone])}>Otopilot · {STATE_INFO[autopilot.state].label}:</span> {autopilot.detail}
            </span>
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {item.canResend && (!item.retry || RETRY_NOT_SENT.has(item.retry.state)) && (
            <Button variant="tonal" size="sm" disabled={busy} icon={<Pencil className="size-3.5" aria-hidden />} onClick={onResend}>
              Düzenle ve tekrar gönder
            </Button>
          )}
          {item.suggestedUrl && (
            <LinkButton href={absoluteUrl(item.suggestedUrl)} size="sm" variant="outline" icon={<ExternalLink className="size-3.5" aria-hidden />}>
              Başvuru sayfasını aç
            </LinkButton>
          )}
          <Button variant="ghost" size="sm" onClick={onShow}>
            Maili göster
          </Button>
        </div>
      </div>
      <Menu
        trigger={
          <IconButton label={`${item.company} dönüşü için işlemler`} size="sm">
            <EllipsisVertical className="size-4" aria-hidden />
          </IconButton>
        }
        items={[
          item.status !== 'resolved' && { label: 'Çözüldü olarak işaretle', onSelect: () => onStatus('resolved') },
          item.status !== 'ignored' && { label: 'Yok say', onSelect: () => onStatus('ignored') },
          item.status !== 'open' && { label: 'Yeniden aç', onSelect: () => onStatus('open') },
        ]}
      />
    </li>
  );
}

export function InboxTab({ inbox, ai }: { inbox: HomeInboxWithAutopilot | undefined; ai: HomeAi }) {
  const { busy, run } = useAction();
  const refreshHome = useRefreshHome();
  const confirm = useConfirm();
  const [view, setView] = useState<InboxView>('todo');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [resendFor, setResendFor] = useState<InboxItem | null>(null);
  const [params, setParams] = useSearchParams();
  const [chosenItem, setShown] = useState<InboxItem | null>(null);
  const [summary, setSummary] = useState<ResendManyResult | null>(null);

  const items = useMemo(() => inbox?.items ?? [], [inbox]);
  const linkedId = params.get(LINK_PARAMS.inbound);
  const linked = linkedId ? items.find((m) => m.id === linkedId) : undefined;
  const shown = chosenItem ?? linked ?? null;
  const closeShown = () => {
    setShown(null);
    if (linkedId) setParams((current) => withoutParams(current, LINK_PARAMS.inbound), { replace: true });
  };
  const counts = useMemo(() => inboxViewCounts(items), [items]);
  const visible = useMemo(() => filterInbox(items, view, query), [items, view, query]);
  const autopilotOf = useMemo(() => new Map((inbox?.autopilot.actions ?? []).map((action) => [action.messageId, action])), [inbox]);
  const selectable = useMemo(() => (view === 'todo' ? visible.filter((m) => m.canResend && m.status === 'open') : []), [visible, view]);
  const chosen = selectable.filter((m) => selected.has(m.id));
  const allChosen = selectable.length > 0 && chosen.length === selectable.length;

  if (!inbox) return <LoadingBlock label="Mail dönüşleri yükleniyor…" />;

  const changeView = (next: InboxView) => {
    setView(next);
    setSelected(new Set());
  };
  const setStatus = (ids: string[], status: InboxStatus, success?: string) => run(() => homeApi.setInboxStatus(ids, status), { success }).then(() => setSelected(new Set()));

  const resendMany = async () => {
    const attemptIds = [...new Set(chosen.map((m) => m.attemptId).filter((id): id is string => !!id))];
    const ok = await confirm({
      title: `${attemptIds.length} başvuru tekrar gönderilsin mi?`,
      message: 'Aynı yazı ve eklerle gönderilir. Adresi geçersiz olanlarda firmanın bilinen bir sonraki uygun adresi ya da firmanın önerdiği adres kullanılır; uygun adresi olmayanlar ve biçim/kanal değişikliği isteyenler atlanır, onları tek tek düzenleyebilirsin.',
      confirmLabel: 'Gönder',
    });
    if (!ok) return;
    const result = await run(() => homeApi.resendMany(attemptIds));
    if (!result) return;
    setSelected(new Set());
    setSummary(result);
  };

  return (
    <div className="flex flex-col gap-4">
      <TrackingPanel inbox={inbox} busy={busy} run={run} />
      <JobAlertsPanel inbox={inbox} />
      <AutopilotPanel overview={inbox.autopilot} ai={ai} />
      {items.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Dönüş türü">
              {INBOX_VIEWS.map((key) => (
                <FilterChip key={key} active={view === key} onToggle={() => changeView(key)} count={counts[key]}>
                  {INBOX_VIEW_LABELS[key]}
                </FilterChip>
              ))}
            </div>
            <SearchInput className="min-w-56 flex-1" value={query} onChange={setQuery} label="Mail dönüşlerinde ara" placeholder="Firma, adres veya neden ara" />
          </div>
          {selectable.length > 0 && (
            <div className="sticky top-14 z-30 -mx-1 flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface/95 px-3 py-1.5 shadow-sm backdrop-blur">
              <Checkbox checked={allChosen} onChange={() => setSelected(allChosen ? new Set() : new Set(selectable.map((m) => m.id)))} label={allChosen ? 'Seçimi kaldır' : `Tümünü seç (${selectable.length})`} />
              {chosen.length > 0 && (
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <span className="text-sm text-ink-soft">{chosen.length} seçili</span>
                  <Button variant="tonal" size="sm" disabled={busy} icon={<Send className="size-4" aria-hidden />} onClick={resendMany}>
                    Toplu tekrar gönder ({chosen.length})
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy} icon={<Check className="size-4" aria-hidden />} onClick={() => setStatus(chosen.map((m) => m.id), 'resolved', 'Çözüldü olarak işaretlendi')}>
                    Çözüldü
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setStatus(chosen.map((m) => m.id), 'ignored', 'Yok sayıldı')}>
                    Yok say
                  </Button>
                </div>
              )}
            </div>
          )}
          {visible.length === 0 ? (
            <Panel>
              <EmptyState icon={<Inbox aria-hidden />}>{query ? 'Bu aramayla eşleşen dönüş yok.' : view === 'todo' ? 'Müdahale gereken dönüş yok.' : 'Bu grupta dönüş yok.'}</EmptyState>
            </Panel>
          ) : (
            <Panel padded={false}>
              <ul className="divide-y divide-line">
                {visible.map((item) => (
                  <InboxRow
                    key={item.id}
                    item={item}
                    autopilot={autopilotOf.get(item.id)}
                    selectable={selectable.includes(item)}
                    selected={selected.has(item.id)}
                    busy={busy}
                    onToggle={() => setSelected((current) => new Set(current.has(item.id) ? [...current].filter((x) => x !== item.id) : [...current, item.id]))}
                    onResend={() => setResendFor(item)}
                    onShow={() => setShown(item)}
                    onStatus={(status) => setStatus([item.id], status)}
                  />
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
      {resendFor?.attemptId && (
        <ResendDialog
          attemptId={resendFor.attemptId}
          message={resendFor}
          onClose={(sent) => {
            setResendFor(null);
            if (sent) {
              toast.success('Başvuru tekrar gönderim için sıraya alındı');
              void refreshHome();
            }
          }}
        />
      )}
      {shown && <InboundMailDialog item={shown} onClose={closeShown} />}
      {summary && <ResendSummaryDialog result={summary} onClose={() => setSummary(null)} />}
    </div>
  );
}
