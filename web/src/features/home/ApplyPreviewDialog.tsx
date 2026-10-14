import { useQuery } from '@tanstack/react-query';
import { Languages, MailCheck, Search, Send, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorText } from '@/api/client';
import { homeApi } from '@/api/home';
import type { HomePreview, HomePreviewDraft } from '@/api/types';
import { documentLabel } from '@/features/shared/documents';
import { cn } from '@/lib/cn';
import { openBlob } from '@/lib/download';
import { fmtBytes, hostOf } from '@/lib/format';
import { Button } from '@/ui/Button';
import { useConfirm } from '@/ui/confirm-context';
import { Dialog } from '@/ui/Dialog';
import { InlineBusy, KeyValue, LoadingBlock } from '@/ui/feedback';
import { Checkbox, Field, Input, Textarea } from '@/ui/fields';
import { toast } from '@/ui/toast';

const PREVIEW_POLL_MS = 3000;
const RESEARCH_POLL_MS = 5000;
const PREVIEW_TIMEOUT_MS = 4 * 60_000;
const TRANSLATE_TIMEOUT_MS = 3 * 60_000;
const TURKISH_LETTERS = /[ğüşıöçĞÜŞİÖÇ]/;
const RECIPIENT_PROBLEM_PREFIX = 'Alıcı adresi';

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const revisionKey = (draft: HomePreviewDraft) => `${draft.id}:${draft.revision}`;

interface ApplyPreviewDialogProps {
  opportunityId: string;
  /** sent: başvuru sıraya alındıysa true. */
  onClose: (sent: boolean) => void;
}

/** Tek başvurunun önizlemesi: yazı hazırlanana kadar bekler, alıcı/konu/metin/ekler düzenlenir, kaydedilir veya gönderilir. */
export function ApplyPreviewDialog({ opportunityId, onClose }: ApplyPreviewDialogProps) {
  const confirm = useConfirm();
  const alive = useRef(true);
  const preparedFor = useRef<number | null>(null);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [timedOutFor, setTimedOutFor] = useState<number | null>(null);
  const [form, setForm] = useState({ to: '', subject: '', body: '' });
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [filledKey, setFilledKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [researching, setResearching] = useState(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setTimedOutFor(startedAt), PREVIEW_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [startedAt]);
  const timedOut = timedOutFor === startedAt;

  const preview = useQuery({
    queryKey: ['preview', opportunityId, startedAt],
    queryFn: async () => {
      if (preparedFor.current !== startedAt) {
        preparedFor.current = startedAt;
        await homeApi.prepare([opportunityId]);
      }
      return homeApi.preview(opportunityId);
    },
    refetchInterval: (query) => (query.state.data?.status === 'preparing' ? PREVIEW_POLL_MS : false),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const data: HomePreview | undefined = preview.data;
  const draft = data?.status === 'ready' ? data.draft : null;

  if (draft && data && revisionKey(draft) !== filledKey) {
    setFilledKey(revisionKey(draft));
    setForm({ to: draft.toEmail ?? data.suggestedTo ?? '', subject: draft.subject, body: draft.body });
    setSelectedDocs(draft.documents.map((d) => d.id));
  }

  const to = form.to.trim();
  const draftDocs = draft?.documents.map((d) => d.id) ?? [];
  const docsChanged = selectedDocs.length !== draftDocs.length || selectedDocs.some((id) => !draftDocs.includes(id));
  const changed = !!draft && (docsChanged || to !== (draft.toEmail ?? '') || form.subject !== draft.subject || form.body !== draft.body);
  const isTurkish = TURKISH_LETTERS.test(form.body) || TURKISH_LETTERS.test(form.subject);
  const translateTarget = isTurkish ? 'en' : 'tr';
  const chosenSuggestion = data?.recipientSuggestions.find((s) => s.email.toLowerCase() === to.toLowerCase());
  const problems = [...new Set(draft?.problems ?? [])].filter((p) => !(to && p.startsWith(RECIPIENT_PROBLEM_PREFIX)));
  const documents = draft ? (draft.availableDocuments.length ? draft.availableDocuments : draft.documents) : [];

  const guarded = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const save = async () => {
    if (!draft || !changed) return;
    await homeApi.saveDraft(draft, { toEmail: to, subject: form.subject, body: form.body, documentIds: docsChanged ? selectedDocs : undefined });
    await preview.refetch();
  };

  const send = () =>
    guarded(async () => {
      if (!to) throw new Error('Önce alıcı mail adresini gir');
      await save();
      await homeApi.apply([opportunityId]);
      onClose(true);
    });

  const translate = () =>
    guarded(async () => {
      if (!draft) return;
      await save();
      const before = (await homeApi.preview(opportunityId)).draft?.revision ?? draft.revision;
      await homeApi.translateDraft(draft.id, translateTarget);
      setTranslating(true);
      try {
        const deadline = Date.now() + TRANSLATE_TIMEOUT_MS;
        while (alive.current && Date.now() < deadline) {
          await wait(PREVIEW_POLL_MS);
          const next = await homeApi.preview(opportunityId);
          if ((next.draft?.revision ?? 0) > before) {
            await preview.refetch();
            toast.success(translateTarget === 'en' ? 'Mail İngilizceye çevrildi' : 'Mail Türkçeye çevrildi');
            return;
          }
        }
        if (alive.current) toast.info('Çeviri hâlâ sürüyor; biraz sonra pencereyi yeniden açabilirsin.');
      } finally {
        if (alive.current) setTranslating(false);
      }
    });

  const redraft = async () => {
    const ok = await confirm({ title: 'Yazı yeniden yazılsın mı?', message: 'CV\'ndeki bilgilerle bu firmaya yeni bir yazı hazırlanır. Yaptığın düzenlemeler kaybolur.', confirmLabel: 'Yeniden yaz' });
    if (!ok) return;
    await guarded(async () => {
      await homeApi.redraft(opportunityId);
      const restartedAt = Date.now();
      preparedFor.current = restartedAt;
      setFilledKey(null);
      setStartedAt(restartedAt);
    });
  };

  const findRecipient = () =>
    guarded(async () => {
      if (!data) return;
      await homeApi.researchCompany(data.companyId);
      setResearching(true);
      setBusy(false);
      const deadline = Date.now() + PREVIEW_TIMEOUT_MS;
      let found: string | null = null;
      while (alive.current && !found && Date.now() < deadline) {
        await wait(RESEARCH_POLL_MS);
        found = (await homeApi.preview(opportunityId).catch(() => null))?.suggestedTo ?? null;
      }
      if (!alive.current) return;
      setResearching(false);
      if (found) {
        setForm((current) => (current.to.trim() ? current : { ...current, to: found }));
        void preview.refetch();
      } else toast.info('Firmanın yayımlanmış bir başvuru adresi bulunamadı. Adresi biliyorsan elle yazabilirsin.');
    });

  const openDocument = (id: string) => guarded(async () => openBlob(await homeApi.downloadDocument(id)));
  const toggleDoc = (id: string) => setSelectedDocs((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  const title = data ? `${data.company}${data.title ? ` · ${data.title}` : ''}` : 'Başvuru';

  return (
    <Dialog
      open
      onClose={() => onClose(false)}
      locked={busy}
      size="lg"
      title={title}
      footer={
        draft ? (
          <>
            <Button variant="ghost" size="sm" disabled={busy} icon={<Languages className="size-4" aria-hidden />} onClick={translate}>
              {isTurkish ? 'İngilizceye çevir' : 'Türkçeye çevir'}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} icon={<Sparkles className="size-4" aria-hidden />} onClick={redraft}>
              Yeniden yaz
            </Button>
            <span className="flex-1" />
            <Button variant="outline" disabled={busy || !changed} onClick={() => guarded(save)}>
              Kaydet
            </Button>
            <Button variant="primary" loading={busy} icon={<Send className="size-4" aria-hidden />} onClick={send}>
              Gönder
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={() => onClose(false)}>
            Kapat
          </Button>
        )
      }
    >
      {preview.isError ? (
        <p role="alert" className="text-sm text-bad">
          {errorText(preview.error)}
        </p>
      ) : !data || data.status === 'preparing' ? (
        timedOut ? (
          <p className="py-10 text-center text-sm text-ink-soft">Yazı hâlâ hazırlanıyor. Pencereyi kapatıp biraz sonra "Başvur"a yeniden basabilirsin.</p>
        ) : (
          <LoadingBlock label="Firmaya özel yazın hazırlanıyor…" />
        )
      ) : data.status === 'sent' || !draft ? (
        <p className="text-sm">Bu başvuru gönderildi. Ayrıntılarını "Başvurularım" sekmesinde görebilirsin.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {translating && <InlineBusy>Mail çevriliyor…</InlineBusy>}
          {problems.length > 0 && (
            <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">
              Göndermeden önce kontrol et: {problems.join(' · ')}
            </p>
          )}
          <dl>
            <KeyValue label="Gönderen">{draft.fromEmail ?? 'Mail hesabı bağlı değil'}</KeyValue>
          </dl>
          <Field label="Kime" hint={data.recipientOptions.length > 1 ? 'Bulunan adreslerden birini seç ya da adresi elle yaz.' : 'Bulunan en uygun adres otomatik gelir; istersen elle değiştirebilirsin.'}>
            {(props) => <Input {...props} type="email" inputMode="email" autoComplete="off" placeholder="kariyer@firma.com" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}
          </Field>
          {data.recipientOptions.length > 0 && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Bulunan adresler">
              {data.recipientOptions.map((option) => {
                const active = to.toLowerCase() === option.email;
                return (
                  <button
                    key={option.email}
                    type="button"
                    aria-pressed={active}
                    title={[option.delivered && 'Bu adrese gönderilen bir başvurunun ulaştığı görüldü', option.sourceUrl ? `Kaynak: ${option.sourceUrl}` : option.label].filter(Boolean).join(' · ')}
                    onClick={() => setForm({ ...form, to: option.email })}
                    className={cn('inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[13px] transition-colors duration-150', active ? 'border-brand bg-brand-soft text-brand-strong' : 'border-line-strong hover:bg-sunken')}
                  >
                    {option.delivered && <MailCheck className="size-3.5 text-good" aria-hidden />}
                    {option.email} · {option.label}
                    {option.delivered && <span className="text-good">· daha önce ulaştı</span>}
                  </button>
                );
              })}
            </div>
          )}
          {!to && data.recipientSuggestions.length > 0 && !researching && (
            <div className="flex flex-col gap-3 rounded-lg bg-warn-soft p-3 text-sm">
              <p className="font-medium">Firmanın kendi güncel mail adresi bulunamadı. Bulunan öneriler:</p>
              {data.recipientSuggestions.map((s) => (
                <div key={s.email} className="flex flex-col items-start gap-1">
                  <p>
                    {s.email} · {s.label}
                  </p>
                  <p className="text-xs text-ink-soft">
                    {s.note}
                    {hostOf(s.sourceUrl) ? ` Kaynak: ${hostOf(s.sourceUrl)}` : ''}
                  </p>
                  <Button variant="outline" size="sm" onClick={() => setForm({ ...form, to: s.email })}>
                    Bu adresi kullan
                  </Button>
                </div>
              ))}
            </div>
          )}
          {chosenSuggestion && (
            <p className="text-xs text-warn">
              Alıcı: {chosenSuggestion.label}. {chosenSuggestion.note} Yazıyı kontrol edip gönder.
            </p>
          )}
          {!to &&
            (researching ? (
              <InlineBusy>Firmanın İK ve iletişim adresleri araştırılıyor…</InlineBusy>
            ) : (
              <Button variant="ghost" size="sm" className="self-start" disabled={busy} icon={<Search className="size-4" aria-hidden />} onClick={findRecipient}>
                Firma mail adresini araştır
              </Button>
            ))}
          <Field label="Konu">{(props) => <Input {...props} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />}</Field>
          <Field label="Firmaya gidecek yazı">{(props) => <Textarea {...props} rows={14} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />}</Field>
          <section aria-label="Ekler">
            <h3 className="text-sm font-semibold">Ekler</h3>
            <p className="text-xs text-ink-soft">Gönderilecek dosyaları işaretle. Yeni dosyayı Profilim › CV ve portföy bölümünden yükleyebilirsin.</p>
            {documents.length === 0 && <p className="mt-1 text-sm text-ink-soft">Ek yok.</p>}
            <ul className="mt-1">
              {documents.map((doc) => (
                <li key={doc.id} className="flex items-center gap-2">
                  <Checkbox
                    className="min-w-0 flex-1"
                    checked={selectedDocs.includes(doc.id)}
                    onChange={() => toggleDoc(doc.id)}
                    label={
                      <span className="min-w-0">
                        <span className="block truncate">{doc.fileName}</span>
                        <span className="block text-xs text-ink-soft">
                          {documentLabel(doc.type)}{doc.language === 'en' ? ' · İngilizce' : ''} · {fmtBytes(doc.size)}
                        </span>
                      </span>
                    }
                  />
                  <Button variant="ghost" size="sm" onClick={() => openDocument(doc.id)}>
                    Önizle
                  </Button>
                </li>
              ))}
            </ul>
            {draft.links.map((link) => (
              <p key={link} className="text-xs break-all text-ink-soft">
                Bağlantı: {link}
              </p>
            ))}
          </section>
        </div>
      )}
    </Dialog>
  );
}
