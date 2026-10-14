import { CircleCheck, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '@/api/client';
import { homeApi } from '@/api/home';
import type { HomeOpportunity, HomePreview } from '@/api/types';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { Checkbox } from '@/ui/fields';
import { Spinner } from '@/ui/Spinner';
import { toast } from '@/ui/toast';
import { ApplyPreviewDialog } from './ApplyPreviewDialog';

const REVIEW_POLL_MS = 4000;
const PREVIEW_BATCH = 6;

const isSettled = (preview: HomePreview | undefined) => preview?.status === 'ready' || preview?.status === 'sent';

function problemsOf(preview: HomePreview | undefined): string[] | null {
  if (preview?.status !== 'ready' || !preview.draft) return null;
  const problems = [...new Set(preview.draft.problems)];
  if (problems.length) return problems;
  return preview.draft.toEmail ? null : ['alıcı adresi yok'];
}

interface BulkReviewDialogProps {
  items: HomeOpportunity[];
  onClose: (sent: boolean) => void;
}

/** Seçilen başvuruların yazıları hazırlanırken tek tek gözden geçirilir; sorunsuz olanlar kendiliğinden işaretlenir. */
export function BulkReviewDialog({ items, onClose }: BulkReviewDialogProps) {
  const [previews, setPreviews] = useState<Record<string, HomePreview>>({});
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const touched = useRef(new Set<string>());
  const latest = useRef(previews);
  useEffect(() => {
    latest.current = previews;
  }, [previews]);

  const refresh = useCallback(async (ids: string[]) => {
    for (let i = 0; i < ids.length; i += PREVIEW_BATCH) {
      const batch = ids.slice(i, i + PREVIEW_BATCH);
      const results = await Promise.all(batch.map((id) => homeApi.preview(id).catch(() => null)));
      const fresh = batch.flatMap((id, index) => (results[index] ? [[id, results[index]] as const] : []));
      setPreviews((current) => ({ ...current, ...Object.fromEntries(fresh) }));
      setChosen((current) => {
        const next = new Set(current);
        for (const [id, preview] of fresh) {
          if (preview.status === 'ready' && !problemsOf(preview) && !touched.current.has(id)) next.add(id);
          if (preview.status === 'sent') next.delete(id);
        }
        return next;
      });
    }
  }, []);

  useEffect(() => {
    const ids = items.map((item) => item.id);
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      const pending = ids.filter((id) => !isSettled(latest.current[id]));
      if (cancelled || pending.length === 0) return;
      await refresh(pending);
      if (!cancelled) timer = window.setTimeout(tick, REVIEW_POLL_MS);
    };
    homeApi
      .prepare(ids)
      .catch((error) => toast.error(errorText(error)))
      .then(tick);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [items, refresh]);

  const toggle = (id: string, checked: boolean) => {
    touched.current.add(id);
    setChosen((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const closePreview = (sent: boolean) => {
    const id = openId;
    setOpenId(null);
    if (!id) return;
    if (sent) toggle(id, false);
    void refresh([id]);
  };

  const sendChosen = async () => {
    setBusy(true);
    try {
      await homeApi.apply([...chosen]);
      onClose(true);
    } catch (error) {
      toast.error(errorText(error));
      setBusy(false);
    }
  };

  const preparing = items.filter((item) => !isSettled(previews[item.id])).length;
  return (
    <>
      <Dialog
        open
        onClose={() => onClose(false)}
        locked={busy}
        size="lg"
        title={`${items.length} başvuruyu kontrol et`}
        description={preparing > 0 ? `Yazılar hazırlanıyor (${preparing} kaldı). Hazır olanları açıp okuyabilir, düzenleyebilirsin.` : 'Yazılar hazır. Göndermek istediklerini işaretle; ayrıntı için "Önizle"ye bas.'}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => onClose(false)}>
              Kapat
            </Button>
            <Button variant="primary" loading={busy} disabled={chosen.size === 0} icon={<Send className="size-4" aria-hidden />} onClick={sendChosen}>
              Seçilenleri gönder ({chosen.size})
            </Button>
          </>
        }
      >
        <ul className="divide-y divide-line">
          {items.map((item) => {
            const preview = previews[item.id];
            const problems = problemsOf(preview);
            const ready = preview?.status === 'ready';
            const name = `${item.company}${item.title ? ` · ${item.title}` : ''}`;
            return (
              <li key={item.id} className="flex items-start gap-3 py-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center">
                  {ready ? <Checkbox checked={chosen.has(item.id)} onChange={(checked) => toggle(item.id, checked)} aria-label={`${name} gönder`} /> : preview?.status === 'sent' ? <CircleCheck className="size-5 text-good" aria-hidden /> : <Spinner className="text-ink-faint" />}
                </span>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium break-words">{name}</p>
                  {preview?.status === 'sent' ? (
                    <p className="text-ink-soft">Zaten gönderildi</p>
                  ) : !ready ? (
                    <p className="text-ink-soft">Yazı hazırlanıyor…</p>
                  ) : problems ? (
                    <p className="text-bad">Kontrol gerekli: {problems.join(' · ')}</p>
                  ) : (
                    <p className="break-words text-ink-soft">
                      Kime: {preview.draft?.toEmail}
                      <br />
                      Konu: {preview.draft?.subject}
                    </p>
                  )}
                </div>
                {ready && (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setOpenId(item.id)}>
                    Önizle
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Dialog>
      {openId && <ApplyPreviewDialog opportunityId={openId} onClose={closePreview} />}
    </>
  );
}
