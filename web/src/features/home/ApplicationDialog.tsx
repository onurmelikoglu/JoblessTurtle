import { useQuery } from '@tanstack/react-query';
import { Download, MailCheck, Paperclip } from 'lucide-react';
import { errorText } from '@/api/client';
import { homeApi } from '@/api/home';
import type { HomeApplicationDetail, HomeDocument } from '@/api/types';
import { documentLabel } from '@/features/shared/documents';
import { openBlob, saveBlob } from '@/lib/download';
import { fmtBytes, fmtDateTime } from '@/lib/format';
import { Button, IconButton } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { KeyValue, LoadingBlock } from '@/ui/feedback';
import { toast } from '@/ui/toast';

const REPLY_LABELS: Record<string, string> = {
  human_reply: 'Yanıt',
  interview: 'Görüşme daveti',
  rejection: 'Olumsuz yanıt',
  autoresponder: 'Otomatik yanıt',
  bounce: 'Teslim edilemedi',
  do_not_contact: 'İletişim istemiyor',
};

async function fetchDocument(doc: HomeDocument, download: boolean) {
  try {
    const blob = await homeApi.downloadDocument(doc.id);
    if (download) saveBlob(blob, doc.fileName);
    else openBlob(blob);
  } catch (error) {
    toast.error(errorText(error));
  }
}

function Details({ d }: { d: HomeApplicationDetail }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-soft">
        {d.stateLabel} · {fmtDateTime(d.sentAt)}
      </p>
      {d.viaForm && <p className="text-sm text-ink-soft">Bu başvuruyu firmanın kendi formundan ya da başka bir kanaldan yaptın; uygulama mail göndermedi. Aşağıda senin için hazırlanan yazı duruyor.</p>}
      <dl className="flex flex-col gap-1">
        {!d.viaForm && <KeyValue label="Gönderen">{d.fromEmail ?? '-'}</KeyValue>}
        {!d.viaForm && <KeyValue label="Alıcı">{d.toEmail ?? '-'}</KeyValue>}
        <KeyValue label="Konu">{d.subject ?? '-'}</KeyValue>
      </dl>
      <p className="rounded-lg border border-line bg-sunken p-3 text-sm leading-relaxed break-words whitespace-pre-wrap">{d.body ?? ''}</p>
      <section>
        <h3 className="text-sm font-semibold">{d.viaForm ? 'Hazırlanan ekler' : 'Ekler'}</h3>
        {d.documents.length === 0 && <p className="text-sm text-ink-soft">Ek yok</p>}
        <ul>
          {d.documents.map((doc) => (
            <li key={doc.id} className="flex items-center gap-2 py-1">
              <Paperclip className="size-4 shrink-0 text-ink-faint" aria-hidden />
              <span className="min-w-0 flex-1 text-sm">
                <span className="block truncate">{doc.fileName}</span>
                <span className="block text-xs text-ink-soft">
                  {documentLabel(doc.type)} · {fmtBytes(doc.size)}
                </span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => void fetchDocument(doc, false)}>
                Önizle
              </Button>
              <IconButton label={`${doc.fileName} indir`} size="sm" onClick={() => void fetchDocument(doc, true)}>
                <Download className="size-4" aria-hidden />
              </IconButton>
            </li>
          ))}
        </ul>
      </section>
      {d.links.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold">Bağlantılar</h3>
          {d.links.map((link) => (
            <a key={link} href={link} target="_blank" rel="noopener noreferrer" className="block text-sm break-all text-brand hover:underline">
              {link}
            </a>
          ))}
        </section>
      )}
      {d.replies.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold">Gelen yanıtlar</h3>
          <ul className="flex flex-col gap-2 pt-1">
            {d.replies.map((reply) => (
              <li key={reply.id} className="flex gap-2 text-sm">
                <MailCheck className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
                <span className="min-w-0 break-words">
                  <span className="block font-medium">
                    {REPLY_LABELS[reply.classification] ?? 'Yanıt'} · {reply.fromEmail ?? ''}
                  </span>
                  <span className="block text-ink-soft">{reply.subject}</span>
                  <span className="block text-ink-soft">{reply.snippet}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function ApplicationDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useQuery({ queryKey: ['application', id], queryFn: () => homeApi.application(id) });
  const d = detail.data;
  return (
    <Dialog open onClose={onClose} size="lg" title={d ? `${d.company}${d.title ? ` · ${d.title}` : ''}` : 'Başvuru'}>
      {detail.isError ? (
        <p role="alert" className="text-sm text-bad">
          {errorText(detail.error)}
        </p>
      ) : d ? (
        <Details d={d} />
      ) : (
        <LoadingBlock />
      )}
    </Dialog>
  );
}
