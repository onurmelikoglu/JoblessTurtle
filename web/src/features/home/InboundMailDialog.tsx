import { useQuery } from '@tanstack/react-query';
import { errorText } from '@/api/client';
import { homeApi } from '@/api/home';
import type { InboxItem } from '@/api/types';
import { fmtDateTime } from '@/lib/format';
import { Dialog } from '@/ui/Dialog';
import { KeyValue, LoadingBlock } from '@/ui/feedback';

export function InboundMailDialog({ item, onClose }: { item: InboxItem; onClose: () => void }) {
  const detail = useQuery({ queryKey: ['inbox-detail', item.id], queryFn: () => homeApi.inboxDetail(item.id) });
  const d = detail.data;
  return (
    <Dialog open onClose={onClose} size="lg" title={`${item.company} · ${item.label}`}>
      {detail.isError ? (
        <p role="alert" className="text-sm text-bad">
          {errorText(detail.error)}
        </p>
      ) : d ? (
        <div className="flex flex-col gap-3">
          <dl className="flex flex-col gap-1">
            <KeyValue label="Gönderen">{d.fromEmail ?? '-'}</KeyValue>
            <KeyValue label="Konu">{d.subject ?? '-'}</KeyValue>
            <KeyValue label="Tarih">{fmtDateTime(d.receivedAt)}</KeyValue>
          </dl>
          <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{d.body}</p>
        </div>
      ) : (
        <LoadingBlock />
      )}
    </Dialog>
  );
}
