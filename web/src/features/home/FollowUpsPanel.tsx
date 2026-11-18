import { useQuery } from '@tanstack/react-query';
import { BellRing, Send, X } from 'lucide-react';
import { useState } from 'react';
import { homeApi } from '@/api/home';
import { POLL_MS, useAction } from '@/api/queries';
import type { FollowUpItem } from '@/api/types';
import { fmtDate, fmtUntil } from '@/lib/format';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { Field, Input, Select, Switch, Textarea } from '@/ui/fields';
import { Panel } from '@/ui/Panel';

const FOLLOW_UP_KEY = ['home', 'follow-ups'] as const;
const DELAY_OPTIONS = [3, 5, 7, 10, 14, 21];
const MAX_SHOWN = 8;

function FollowUpDialog({ item, busy, onClose, onSend }: { item: FollowUpItem; busy: boolean; onClose: () => void; onSend: (edit: { subject: string; body: string; toEmail: string }) => void }) {
  const draft = item.draft!;
  const [form, setForm] = useState({ toEmail: draft.toEmail ?? item.toEmail ?? '', subject: draft.subject, body: draft.body });
  return (
    <Dialog
      open
      onClose={onClose}
      locked={busy}
      size="lg"
      title={`Takip: ${item.company}${item.title ? ` · ${item.title}` : ''}`}
      footer={
        <>
          <span className="flex-1" />
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Kapat
          </Button>
          <Button variant="primary" loading={busy} icon={<Send className="size-4" aria-hidden />} onClick={() => onSend(form)}>
            Gönder
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {draft.problems.length > 0 && <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">Göndermeden önce kontrol et: {draft.problems.join(' · ')}</p>}
        <Field label="Kime">{(props) => <Input {...props} type="email" value={form.toEmail} onChange={(e) => setForm({ ...form, toEmail: e.target.value })} />}</Field>
        <Field label="Konu">{(props) => <Input {...props} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />}</Field>
        <Field label="Takip yazısı">{(props) => <Textarea {...props} rows={10} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />}</Field>
      </div>
    </Dialog>
  );
}

function statusLine(item: FollowUpItem): string {
  if (item.state === 'pending') return `${fmtUntil(item.dueAt)} hazırlanacak`;
  if (item.state === 'drafted') return 'Takip yazısı hazır';
  if (item.state === 'sent') return 'Takip gönderildi';
  return item.note ? `Kapandı: ${item.note}` : 'Kapandı';
}

/** Yanıt gelmeyen başvuruların takibi: vadesi yaklaşan ve yazısı hazır olanlar, gecikme ve otomatik gönderim ayarı. */
export function FollowUpsPanel() {
  const query = useQuery({ queryKey: FOLLOW_UP_KEY, queryFn: homeApi.followUps, refetchInterval: POLL_MS });
  const { busy, run } = useAction();
  const [open, setOpen] = useState<FollowUpItem | null>(null);
  const data = query.data;
  if (!data) return null;
  const active = data.items.filter((i) => i.state === 'pending' || i.state === 'drafted');
  const ready = active.filter((i) => i.state === 'drafted');
  if (!active.length && !data.settings.hasPolicy) return null;
  const refresh = () => void query.refetch();
  const act = (fn: () => Promise<unknown>, success: string) => run(fn, { success }).then(refresh);

  const send = async (item: FollowUpItem, edit: { subject: string; body: string; toEmail: string }) => {
    const draft = item.draft!;
    const changed = edit.subject !== draft.subject || edit.body !== draft.body || edit.toEmail !== (draft.toEmail ?? '');
    const done = await run(
      async () => {
        if (changed) await homeApi.saveDraft(draft, { toEmail: edit.toEmail, subject: edit.subject, body: edit.body });
        await homeApi.sendFollowUp(item.id);
      },
      { success: `${item.company} için takip gönderime alındı` },
    );
    if (done !== undefined) setOpen(null);
    refresh();
  };

  return (
    <Panel>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <BellRing className="size-4" aria-hidden />
            Takipler
          </h2>
          <span className="text-sm text-ink-soft">{active.length ? `${active.length} başvuru takipte${ready.length ? ` · ${ready.length} takip yazısı hazır` : ''}` : 'Takip bekleyen başvuru yok'}</span>
          {data.settings.hasPolicy && (
            <div className="ml-auto flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                Yanıt gelmezse
                <Select className="w-auto" value={data.settings.delayDays} disabled={busy} onChange={(e) => act(() => homeApi.saveFollowUpSettings({ ...data.settings, delayDays: Number(e.target.value) }), 'Takip süresi güncellendi')}>
                  {DELAY_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d} iş günü
                    </option>
                  ))}
                </Select>
                sonra
              </label>
              <Switch
                label="Takibi otomatik gönder"
                checked={data.settings.auto}
                disabled={busy}
                onChange={(auto) => act(() => homeApi.saveFollowUpSettings({ ...data.settings, auto }), auto ? 'Takipler otomatik gönderilecek' : 'Takipler onayınla gönderilecek')}
              />
            </div>
          )}
        </div>
        {active.length > 0 && (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {active.slice(0, MAX_SHOWN).map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="truncate text-sm font-medium">
                    {item.company}
                    {item.title ? ` · ${item.title}` : ''}
                  </p>
                  <p className="text-xs text-ink-soft">
                    {item.sentAt ? `${fmtDate(item.sentAt)} tarihinde gönderildi · ` : ''}
                    {statusLine(item)}
                  </p>
                </div>
                {item.state === 'drafted' ? (
                  <Button size="sm" variant="tonal" disabled={busy} onClick={() => setOpen(item)}>
                    Önizle ve gönder
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => homeApi.prepareFollowUp(item.id), 'Takip yazısı hazırlandı')}>
                    Şimdi hazırla
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy} icon={<X className="size-3.5" aria-hidden />} onClick={() => act(() => homeApi.skipFollowUp(item.id), 'Takipten vazgeçildi')}>
                  Vazgeç
                </Button>
              </li>
            ))}
          </ul>
        )}
        {active.length > MAX_SHOWN && <p className="text-xs text-ink-soft">ve {active.length - MAX_SHOWN} takip daha; sırası gelince listede görünür.</p>}
      </div>
      {open && <FollowUpDialog item={open} busy={busy} onClose={() => setOpen(null)} onSend={(edit) => void send(open, edit)} />}
    </Panel>
  );
}
