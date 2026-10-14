import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, CheckCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/api/client';
import { queryKeys, useAction } from '@/api/queries';
import type { NotificationItem } from '@/api/types';
import { cn } from '@/lib/cn';
import { fmtDateTime } from '@/lib/format';
import { appTarget } from '@/notification-links';
import { Button } from '@/ui/Button';
import { EmptyState, LoadingBlock } from '@/ui/feedback';
import { Panel } from '@/ui/Panel';

export function NotificationsPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { busy, run } = useAction();
  const list = useQuery({ queryKey: queryKeys.notifications, queryFn: () => api.get<NotificationItem[]>('/v1/notifications') });
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.notifications });

  const open = async (item: NotificationItem) => {
    if (!item.readAt) await api.post(`/v1/notifications/${item.id}/read`).catch(() => undefined);
    void refresh();
    const target = appTarget(item.link, item.type);
    if (target) navigate(target);
  };

  const items = list.data ?? [];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-xl font-semibold">Bildirimler</h1>
        <Button variant="outline" size="sm" icon={<CheckCheck className="size-4" aria-hidden />} loading={busy} disabled={!items.some((n) => !n.readAt)} onClick={() => run(() => api.post('/v1/notifications/read-all').then(refresh), { refresh: false })}>
          Tümünü okundu say
        </Button>
      </div>
      {list.isPending ? (
        <LoadingBlock />
      ) : items.length === 0 ? (
        <Panel>
          <EmptyState icon={<BellOff aria-hidden />}>Bildirim yok.</EmptyState>
        </Panel>
      ) : (
        <Panel padded={false} className="divide-y divide-line overflow-hidden">
          {items.map((item) => (
            <button key={item.id} type="button" onClick={() => void open(item)} className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-sunken">
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
          ))}
        </Panel>
      )}
    </div>
  );
}
