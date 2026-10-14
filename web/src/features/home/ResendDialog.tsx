import { useQuery } from '@tanstack/react-query';
import { AtSign, ChevronDown, ChevronUp, Reply, Send } from 'lucide-react';
import { useState } from 'react';
import { errorText } from '@/api/client';
import { homeApi } from '@/api/home';
import type { InboxItem } from '@/api/types';
import { documentLabel } from '@/features/shared/documents';
import { cn } from '@/lib/cn';
import { fmtBytes, fmtDateTime } from '@/lib/format';
import { Button } from '@/ui/Button';
import { useConfirm } from '@/ui/confirm-context';
import { Dialog } from '@/ui/Dialog';
import { LoadingBlock } from '@/ui/feedback';
import { Checkbox, Field, Input, Textarea } from '@/ui/fields';
import { toast } from '@/ui/toast';
import { TONE_SOFT } from '@/ui/tones';
import { DEAD_ADDRESS_CATEGORIES, INBOX_GROUP_TONE } from './model';

const OVERSIZE_CATEGORY = 'too_large';

interface ResendDialogProps {
  attemptId: string;
  /** Başvuruya gelen dönüş (varsa): öneri adres, alternatifler ve ne yapılacağına dair ipucu buradan gelir. */
  message: InboxItem | null;
  onClose: (sent: boolean) => void;
}

/** Gönderilmiş başvuruyu düzenleyip (alıcı, konu, metin, ekler) yeniden sıraya alır. */
export function ResendDialog({ attemptId, message, onClose }: ResendDialogProps) {
  const confirm = useConfirm();
  const application = useQuery({ queryKey: ['application', attemptId], queryFn: () => homeApi.application(attemptId), staleTime: Infinity });
  const inbound = useQuery({ queryKey: ['inbox-detail', message?.id], queryFn: () => homeApi.inboxDetail(message!.id), enabled: !!message, staleTime: Infinity });
  const [form, setForm] = useState<{ to: string; subject: string; body: string; documents: string[] } | null>(null);
  const [showInbound, setShowInbound] = useState(false);
  const [sending, setSending] = useState(false);

  const detail = application.data;
  const category = message?.category ?? '';
  const deadAddress = DEAD_ADDRESS_CATEGORIES.has(category);
  const alternatives = message?.alternatives ?? [];
  const documents = detail ? (detail.currentDocuments.length ? detail.currentDocuments : detail.documents) : [];

  if (detail && !form) {
    const to = message?.suggestedEmail ?? (deadAddress && alternatives.length ? alternatives[0].email : (detail.toEmail ?? ''));
    const attached = documents.filter((d) => category !== OVERSIZE_CATEGORY || d.type === 'cv');
    setForm({ to, subject: detail.subject ?? '', body: detail.body ?? '', documents: attached.map((d) => d.id) });
  }

  const send = async () => {
    if (!form || !detail) return;
    const recipient = form.to.trim();
    if (!recipient.includes('@')) return toast.error('Geçerli bir alıcı adresi gir');
    if (deadAddress && recipient.toLowerCase() === detail.toEmail?.toLowerCase()) {
      const ok = await confirm({ title: 'Aynı adrese gönderilsin mi?', message: 'Bu adres geri döndü. Aynı adrese tekrar göndermek büyük ihtimalle yine başarısız olur.', confirmLabel: 'Yine de gönder' });
      if (!ok) return;
    }
    setSending(true);
    try {
      await homeApi.resend(attemptId, { toEmail: recipient, subject: form.subject, body: form.body, documentIds: form.documents });
      onClose(true);
    } catch (error) {
      toast.error(errorText(error));
      setSending(false);
    }
  };

  const toggleDocument = (id: string) => form && setForm({ ...form, documents: form.documents.includes(id) ? form.documents.filter((x) => x !== id) : [...form.documents, id] });

  return (
    <Dialog
      open
      onClose={() => onClose(false)}
      locked={sending}
      size="lg"
      title={detail ? `Tekrar gönder · ${detail.company}` : 'Tekrar gönder'}
      footer={
        <>
          <Button variant="ghost" disabled={sending} onClick={() => onClose(false)}>
            Vazgeç
          </Button>
          <Button variant="primary" loading={sending} disabled={!form} icon={<Send className="size-4" aria-hidden />} onClick={send}>
            Sıraya al ve gönder
          </Button>
        </>
      }
    >
      {application.isError ? (
        <p role="alert" className="text-sm text-bad">
          {errorText(application.error)}
        </p>
      ) : !form || !detail ? (
        <LoadingBlock />
      ) : (
        <div className="flex flex-col gap-4">
          {message && (
            <div className={cn('flex flex-col items-start gap-1 rounded-lg p-3 text-sm', TONE_SOFT[INBOX_GROUP_TONE[message.group] ?? 'neutral'])}>
              <p className="font-semibold">{message.label}</p>
              {message.reason && message.reason !== message.label && <p className="text-ink">{message.reason}</p>}
              {message.hint && <p className="text-ink-soft italic">{message.hint}</p>}
              {inbound.data && (
                <Button variant="ghost" size="sm" className="-ml-2" aria-expanded={showInbound} icon={showInbound ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />} onClick={() => setShowInbound((v) => !v)}>
                  {showInbound ? 'Gelen maili gizle' : 'Gelen maili göster'}
                </Button>
              )}
              {showInbound && inbound.data && (
                <p className="text-xs break-words whitespace-pre-wrap text-ink">
                  {inbound.data.fromEmail ?? ''} · {fmtDateTime(inbound.data.receivedAt)}
                  {'\n'}
                  {inbound.data.subject ?? ''}
                  {'\n\n'}
                  {inbound.data.body}
                </p>
              )}
            </div>
          )}
          <Field label="Alıcı" hint={detail.toEmail ? `Önceki alıcı: ${detail.toEmail}` : undefined}>
            {(props) => <Input {...props} type="email" inputMode="email" autoComplete="off" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}
          </Field>
          {alternatives.length > 0 && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Firmanın diğer adresleri">
              {alternatives.map((alternative) => (
                <button
                  key={alternative.email}
                  type="button"
                  title={alternative.source === 'reply' ? 'Firmanın yanıtında önerilen adres' : 'Firmanın bilinen diğer adresi'}
                  onClick={() => setForm({ ...form, to: alternative.email })}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line-strong px-3 py-1 text-[13px] hover:bg-sunken"
                >
                  {alternative.source === 'reply' ? <Reply className="size-3.5" aria-hidden /> : <AtSign className="size-3.5" aria-hidden />}
                  {alternative.email}
                </button>
              ))}
            </div>
          )}
          <Field label="Konu">{(props) => <Input {...props} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />}</Field>
          <Field label="Mail metni">{(props) => <Textarea {...props} rows={12} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />}</Field>
          <section aria-label="Ekler">
            <h3 className="text-sm font-semibold">Ekler</h3>
            {category === OVERSIZE_CATEGORY && <p className="text-sm text-warn">Alıcının boyut sınırı aşıldı. Portföyü ek yerine bağlantı olarak metne eklemen önerilir.</p>}
            {documents.length === 0 && <p className="text-sm text-ink-soft">Ek yok</p>}
            {documents.map((doc) => (
              <Checkbox
                key={doc.id}
                className="flex"
                checked={form.documents.includes(doc.id)}
                onChange={() => toggleDocument(doc.id)}
                label={
                  <span className="min-w-0">
                    <span className="block truncate">{doc.fileName}</span>
                    <span className="block text-xs text-ink-soft">
                      {documentLabel(doc.type)} · {fmtBytes(doc.size)}
                    </span>
                  </span>
                }
              />
            ))}
          </section>
          <p className="text-xs text-ink-soft">Mail, diğer gönderimler gibi 30-50 sn aralıklı kuyruğa alınır. Önceki başvuru "tekrar gönderildi" olarak işaretlenir.</p>
        </div>
      )}
    </Dialog>
  );
}
