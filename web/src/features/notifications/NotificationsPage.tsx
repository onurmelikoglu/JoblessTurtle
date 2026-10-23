import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, CheckCheck, SearchX, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/api/client';
import { queryKeys, useAction } from '@/api/queries';
import type { NotificationClearRange, NotificationDeleteResult, NotificationItem, NotificationPage } from '@/api/types';
import { cn } from '@/lib/cn';
import { fmtDateTime } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { appTarget } from '@/notification-links';
import { Button } from '@/ui/Button';
import { useConfirm } from '@/ui/confirm-context';
import { EmptyState, LoadingBlock } from '@/ui/feedback';
import { Menu } from '@/ui/Menu';
import { Panel } from '@/ui/Panel';
import { NotificationFilterBar } from './NotificationFilterBar';
import { CLEAR_OPTIONS, clearConfirm, clearedMessage, EMPTY_FILTERS, hasActiveFilters, listParams, rangeError, resultSummary, SEARCH_DEBOUNCE_MS, type NotificationFilters } from './notifications-model';

export function NotificationsPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const confirm = useConfirm();
  const { busy, run } = useAction();
  const [filters, setFilters] = useState<NotificationFilters>(EMPTY_FILTERS);
  const query = useDebounced(filters.query, SEARCH_DEBOUNCE_MS);
  const applied = { ...filters, query };
  const invalid = !!rangeError(applied);
  const filtered = hasActiveFilters(applied);

  const list = useInfiniteQuery({
    queryKey: [...queryKeys.notifications, 'list', listParams(applied)],
    queryFn: ({ pageParam }) => api.get<NotificationPage>('/v1/notifications', listParams(applied, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: !invalid,
  });
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.notifications });
  const patch = (next: Partial<NotificationFilters>) => setFilters((current) => ({ ...current, ...next }));

  const open = async (item: NotificationItem) => {
    if (!item.readAt) await api.post(`/v1/notifications/${item.id}/read`).catch(() => undefined);
    void refresh();
    const target = appTarget(item.link, item.type);
    if (target) navigate(target);
  };

  const clear = async (range: NotificationClearRange) => {
    if (!(await confirm(clearConfirm(range, filtered)))) return;
    await run(() => api.delete<NotificationDeleteResult>('/v1/notifications', { range }).finally(refresh), { refresh: false, success: (r) => clearedMessage(r.deleted) });
  };

  const remove = (item: NotificationItem) => run(() => api.delete(`/v1/notifications/${item.id}`).finally(refresh), { refresh: false, success: 'Bildirim silindi.' });

  const pages = list.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const first = pages[0];
  const searching = query !== filters.query || list.isPlaceholderData;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">Bildirimler</h1>
        <div className="flex gap-2 max-sm:w-full [&>*]:max-sm:flex-1">
          <Button variant="outline" size="sm" icon={<CheckCheck className="size-4" aria-hidden />} loading={busy} disabled={!first?.unread} onClick={() => run(() => api.post('/v1/notifications/read-all').then(refresh), { refresh: false })}>
            Tümünü okundu say
          </Button>
          <Menu
            trigger={
              <Button variant="outline" size="sm" icon={<Trash2 className="size-4" aria-hidden />} disabled={busy}>
                Geçmişi temizle
              </Button>
            }
            items={[{ heading: 'Şu aralıkta gelenleri sil' }, ...CLEAR_OPTIONS.map((option) => ({ label: option.label, danger: true, onSelect: () => void clear(option.range) }))]}
          />
        </div>
      </div>
      <p className="-mt-2 text-sm text-ink-soft">Son 30 günün bildirimleri; daha eskiler kendiliğinden silinir.</p>
      <NotificationFilterBar filters={filters} onChange={patch} onReset={() => setFilters(EMPTY_FILTERS)} />
      <p className="-mb-1 text-sm text-ink-soft" aria-live="polite">
        {invalid ? 'Tarih aralığını düzeltin.' : searching ? 'Aranıyor…' : first?.total ? resultSummary(first.total, filtered) : ''}
      </p>
      {list.isPending && !invalid ? (
        <LoadingBlock />
      ) : items.length === 0 ? (
        <Panel>
          {filtered ? (
            <EmptyState
              icon={<SearchX aria-hidden />}
              action={
                <Button variant="outline" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
                  Filtreyi temizle
                </Button>
              }
            >
              Filtreye uyan bildirim yok.
            </EmptyState>
          ) : (
            <EmptyState icon={<BellOff aria-hidden />}>Bildirim yok.</EmptyState>
          )}
        </Panel>
      ) : (
        <Panel padded={false} className={cn('divide-y divide-line overflow-hidden', list.isPlaceholderData && 'opacity-60')}>
          {items.map((item) => (
            <div key={item.id} className="group flex items-start transition-colors duration-150 hover:bg-sunken">
              <button type="button" onClick={() => void open(item)} className="flex min-w-0 flex-1 items-start gap-3 py-3 pl-4 text-left">
                <span className={cn('mt-2 size-2 shrink-0 rounded-full', item.readAt ? 'bg-line-strong' : 'bg-brand')} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-sm', !item.readAt && 'font-semibold')}>{item.title}</span>
                  {item.body && <span className="block text-sm break-words text-ink-soft">{item.body}</span>}
                  <span className="block text-xs text-ink-faint">
                    {fmtDateTime(item.createdAt)}
                    {!item.readAt && <span className="sr-only"> · okunmadı</span>}
                  </span>
                </span>
              </button>
              <button
                type="button"
                aria-label={`Bildirimi sil: ${item.title}`}
                title="Bildirimi sil"
                disabled={busy}
                onClick={() => void remove(item)}
                className="m-2 shrink-0 rounded-md p-2 text-ink-faint transition-opacity hover:bg-surface hover:text-bad focus-visible:opacity-100 disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
          ))}
          {list.hasNextPage && (
            <div className="flex justify-center p-3">
              <Button variant="ghost" size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                Daha fazla göster
              </Button>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
