import { ArrowUpDown, CalendarClock, Inbox, MailWarning, Send, Trash2, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { homeApi, type Outcome } from '@/api/home';
import { useAction, useRefreshHome } from '@/api/queries';
import type { HomeApplication, HomeApplications, InboxItem } from '@/api/types';
import { LINK_PARAMS, withoutParams } from '@/notification-links';
import { Button } from '@/ui/Button';
import { useConfirm } from '@/ui/confirm-context';
import { SearchInput } from '@/ui/controls';
import { EmptyState, LoadingBlock } from '@/ui/feedback';
import { Checkbox, Select } from '@/ui/fields';
import { Notice } from '@/ui/Notice';
import { Panel } from '@/ui/Panel';
import { toast } from '@/ui/toast';
import { APPLICATION_SORT_LABELS, DEFAULT_APPLICATION_FILTERS, filterApplications, RANGE_LABELS, type ApplicationFilters, type ApplicationSort, type DateRange } from './application-filters';
import { ApplicationDialog } from './ApplicationDialog';
import { ApplicationSummary, SendQueuePanel } from './ApplicationPanels';
import { ApplicationRow, type ApplicationRowActions } from './ApplicationRow';
import { bucketOf } from './model';
import { ResendDialog } from './ResendDialog';
import { RetryQueueDialog } from './RetryQueueDialog';

const SKIPPED_NAMES_SHOWN = 5;

interface ApplicationsTabProps {
  data: HomeApplications | undefined;
  inboxItems: InboxItem[];
  inboxTodo: number;
  onOpenInbox: () => void;
}

export function ApplicationsTab({ data, inboxItems, inboxTodo, onOpenInbox }: ApplicationsTabProps) {
  const { busy, run } = useAction();
  const refreshHome = useRefreshHome();
  const confirm = useConfirm();
  const [filters, setFilters] = useState<ApplicationFilters>(DEFAULT_APPLICATION_FILTERS);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [params, setParams] = useSearchParams();
  const [chosenDetailId, setDetailId] = useState<string | null>(null);
  const detailId = chosenDetailId ?? params.get(LINK_PARAMS.application);
  const closeDetail = () => {
    setDetailId(null);
    if (params.has(LINK_PARAMS.application)) setParams((current) => withoutParams(current, LINK_PARAMS.application), { replace: true });
  };
  const [resendId, setResendId] = useState<string | null>(null);
  const [retryOpen, setRetryOpen] = useState(false);

  const applications = useMemo(() => data?.items ?? [], [data]);
  const visible = useMemo(() => filterApplications(applications, filters), [applications, filters]);
  const visibleIds = useMemo(() => new Set(visible.map((a) => a.id)), [visible]);
  const chosen = useMemo(() => visible.filter((a) => selected.has(a.id)), [visible, selected]);
  const allChosen = visible.length > 0 && chosen.length === visible.length;
  const patch = (next: Partial<ApplicationFilters>) => {
    setFilters((current) => ({ ...current, ...next }));
    setSelected(new Set());
  };

  if (!data) return <LoadingBlock label="Başvurular yükleniyor…" />;
  if (applications.length === 0) {
    return (
      <Panel>
        <EmptyState icon={<Send aria-hidden />}>Henüz başvuru yok. "Firmalar" sekmesinden seçip başvurabilirsin.</EmptyState>
      </Panel>
    );
  }

  const queuedChosen = chosen.filter((a) => a.state === 'queued');
  const failedChosen = chosen.filter((a) => bucketOf(a) === 'failed');
  const requeued = (result: { requeued: number }) => (result.requeued === 0 ? 'Bekleyen başvuru yok' : `${result.requeued} başvuru yeniden gönderime alındı; limit doluysa yeniden ertelenir.`);
  const retry = (ids: string[]) => run(() => homeApi.retryApplications(ids), { success: requeued });

  const remove = async (items: HomeApplication[]) => {
    const queued = items.filter((a) => a.state === 'queued').length;
    const others = items.length - queued;
    const ok = await confirm({
      title: items.length === 1 ? 'Başvuru silinsin mi?' : `${items.length} başvuru silinsin mi?`,
      message: [queued > 0 && `${queued} sıradaki başvuru iptal edilecek, mail gönderilmeyecek.`, others > 0 && `${others} başvuru listeden kaldırılacak; gönderilmiş mail geri alınamaz ve bu firmalara 30 gün tekrar başvurulmaz.`].filter(Boolean).join(' '),
      confirmLabel: 'Sil',
      danger: true,
    });
    if (!ok) return;
    await run(() => homeApi.removeApplications(items.map((a) => a.id)), { success: items.length === 1 ? 'Başvuru silindi' : `${items.length} başvuru silindi` });
    setSelected(new Set());
  };

  const resendFailed = async () => {
    const ok = await confirm({
      title: `${failedChosen.length} başvuru tekrar gönderilsin mi?`,
      message: 'Aynı yazı ve güncel eklerle gönderilir. Adresi geçersiz olanlarda firmanın bilinen bir sonraki uygun adresi kullanılır; uygun adresi olmayanlar atlanır, onları "Düzenle ve tekrar gönder" ile tek tek düzeltebilirsin.',
      confirmLabel: 'Gönder',
    });
    if (!ok) return;
    const result = await run(() => homeApi.resendMany(failedChosen.map((a) => a.id)));
    if (!result) return;
    setSelected(new Set());
    const skipped = result.results.filter((r) => r.status === 'skipped');
    toast.info(`${result.queued} başvuru sıraya alındı${skipped.length ? `; ${skipped.length} başvurunun başka geçerli adresi yok (${skipped.slice(0, SKIPPED_NAMES_SHOWN).map((r) => r.company).join(', ')}${skipped.length > SKIPPED_NAMES_SHOWN ? '…' : ''})` : ''}`);
  };

  const rowActions: ApplicationRowActions = {
    onOpen: (a) => setDetailId(a.id),
    onToggle: (id) => setSelected((current) => new Set(current.has(id) ? [...current].filter((x) => x !== id) : [...current, id])),
    onRetry: (a) => retry([a.id]),
    onResend: (a) => setResendId(a.id),
    onUndo: (a) => run(() => homeApi.undoApplied(a.id), { success: 'Başvurdum işareti kaldırıldı; firma yeniden Firmalar sekmesinde' }),
    onOutcome: (a, outcome: Outcome) => run(() => homeApi.recordOutcome(a.id, outcome), { success: 'Kaydedildi' }),
    onRemove: (a) => remove([a]),
  };

  return (
    <div className="flex flex-col gap-4">
      {inboxTodo > 0 && (
        <Notice
          tone="warn"
          icon={<MailWarning className="size-5 shrink-0" aria-hidden />}
          action={
            <Button variant="outline" size="sm" icon={<Inbox className="size-4" aria-hidden />} onClick={onOpenInbox}>
              Dönüşlere git
            </Button>
          }
        >
          {inboxTodo} başvuru için gelen kutuna hata bildirimi ya da yönlendirme geldi; düzenleyip tekrar gönderebilirsin.
        </Notice>
      )}
      {data.queue && <SendQueuePanel queue={data.queue} busy={busy} onRetry={() => setRetryOpen(true)} />}
      <ApplicationSummary applications={applications} active={filters.bucket} onSelect={(bucket) => patch({ bucket })} />
      <div className="flex flex-wrap gap-2">
        <SearchInput className="min-w-56 flex-1" value={filters.query} onChange={(query) => patch({ query })} label="Başvurularda ara" placeholder="Firma, pozisyon veya alıcı adresi ara" />
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <CalendarClock className="size-4" aria-hidden />
          <span className="sr-only">Tarih aralığı</span>
          <Select className="w-auto" value={filters.range} onChange={(e) => patch({ range: e.target.value as DateRange })}>
            {(Object.keys(RANGE_LABELS) as DateRange[]).map((range) => (
              <option key={range} value={range}>
                {RANGE_LABELS[range]}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <ArrowUpDown className="size-4" aria-hidden />
          <span className="sr-only">Sıralama</span>
          <Select className="w-auto" value={filters.sort} onChange={(e) => patch({ sort: e.target.value as ApplicationSort })}>
            {(Object.keys(APPLICATION_SORT_LABELS) as ApplicationSort[]).map((sort) => (
              <option key={sort} value={sort}>
                {APPLICATION_SORT_LABELS[sort]}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <div className="sticky top-14 z-30 -mx-1 flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface/95 px-3 py-1.5 shadow-sm backdrop-blur">
        <Checkbox checked={allChosen} disabled={visible.length === 0} onChange={() => setSelected(allChosen ? new Set() : visibleIds)} label={allChosen ? 'Seçimi kaldır' : `Görünenlerin tümünü seç (${visible.length})`} />
        {chosen.length > 0 && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-sm text-ink-soft">{chosen.length} seçili</span>
            {queuedChosen.length > 0 && (
              <Button variant="tonal" size="sm" disabled={busy} icon={<Send className="size-4" aria-hidden />} onClick={() => retry(queuedChosen.map((a) => a.id))}>
                Şimdi gönder ({queuedChosen.length})
              </Button>
            )}
            {failedChosen.length > 0 && (
              <Button variant="tonal" size="sm" disabled={busy} icon={<Undo2 className="size-4" aria-hidden />} onClick={resendFailed}>
                Tekrar gönder ({failedChosen.length})
              </Button>
            )}
            <Button variant="danger" size="sm" disabled={busy} icon={<Trash2 className="size-4" aria-hidden />} onClick={() => remove(chosen)}>
              Sil ({chosen.length})
            </Button>
          </div>
        )}
      </div>
      {visible.length === 0 ? (
        <Panel>
          <EmptyState icon={<Send aria-hidden />}>Bu arama ve filtrelerle eşleşen başvuru yok.</EmptyState>
        </Panel>
      ) : (
        <Panel padded={false}>
          <ul className="divide-y divide-line">
            {visible.map((application) => (
              <ApplicationRow key={application.id} application={application} selected={selected.has(application.id)} {...rowActions} />
            ))}
          </ul>
        </Panel>
      )}
      {detailId && <ApplicationDialog id={detailId} onClose={closeDetail} />}
      {resendId && (
        <ResendDialog
          attemptId={resendId}
          message={inboxItems.find((m) => m.attemptId === resendId) ?? null}
          onClose={(sent) => {
            setResendId(null);
            if (sent) {
              toast.success('Başvuru tekrar gönderim için sıraya alındı');
              void refreshHome();
            }
          }}
        />
      )}
      {retryOpen && (
        <RetryQueueDialog
          queued={applications.filter((a) => a.state === 'queued')}
          onClose={(ids) => {
            setRetryOpen(false);
            if (ids?.length) void retry(ids);
          }}
        />
      )}
    </div>
  );
}
