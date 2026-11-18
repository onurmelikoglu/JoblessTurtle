import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Eye, Star, Trash2 } from 'lucide-react';
import { homeApi } from '@/api/home';
import { useAction } from '@/api/queries';
import type { HomeAtsDocument } from '@/api/types';
import { DocumentPreviewDialog } from '@/features/shared/DocumentPreviewDialog';
import { fmtBytes, fmtDate } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { useConfirm } from '@/ui/confirm-context';
import { Notice } from '@/ui/Notice';
import { SubSection } from './parts';

const ATS_DOCUMENTS_QUERY = ['home', 'ats-documents'] as const;

function AtsRow({ doc, busy, onPromote, onDiscard, onOpen }: { doc: HomeAtsDocument; busy: boolean; onPromote: () => void; onDiscard: () => void; onOpen: () => void }) {
  const main = doc.variant === 'ats_main';
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{main ? 'Ana ATS CV' : 'İlana özel ATS CV'}</span>
          <Badge tone="neutral">{doc.language === 'en' ? 'İngilizce' : 'Türkçe'}</Badge>
          {doc.pendingPromotion && <Badge tone="good">Diğer ilanlarda da daha iyi</Badge>}
        </div>
        <p className="text-xs text-ink-soft">
          {doc.job ? `${doc.job} · ` : ''}
          {fmtDate(doc.createdAt)} · {fmtBytes(doc.size)}
          {doc.addedSkills.length > 0 && ` · kanıtsız eklenen: ${doc.addedSkills.join(', ')}`}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-1">
        <Button variant="ghost" size="sm" icon={<Eye className="size-4" aria-hidden />} onClick={onOpen}>
          Önizle
        </Button>
        {!main && (
          <Button variant={doc.pendingPromotion ? 'tonal' : 'ghost'} size="sm" disabled={busy} icon={<Star className="size-4" aria-hidden />} onClick={onPromote}>
            Ana CV yap
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={busy} icon={<Trash2 className="size-4" aria-hidden />} onClick={onDiscard}>
          Temizle
        </Button>
      </div>
    </li>
  );
}

/**
 * Yapay zekânın ilanlara göre ürettiği ATS CV sürümleri. Orijinal CV hiç değişmez; dil başına bir ana ATS CV ve
 * gerektiğinde ilana özel sürümler tutulur. İlana özel sürüm diğer ilanlarda da daha iyiyse ana yapılması önerilir.
 */
const ATS_CV_MIME = 'application/pdf';

export function AtsDocuments() {
  const docs = useQuery({ queryKey: ATS_DOCUMENTS_QUERY, queryFn: homeApi.atsDocuments });
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [previewing, setPreviewing] = useState<HomeAtsDocument | null>(null);
  if (!docs.data?.length) return null;
  const pending = docs.data.filter((d) => d.pendingPromotion);

  const promote = (doc: HomeAtsDocument) =>
    run(() => homeApi.promoteAts(doc.id), { success: 'Ana ATS CV güncellendi; eski sürüm arşivlendi' }).then(() => docs.refetch());
  const discard = async (doc: HomeAtsDocument) => {
    const ok = await confirm({ title: 'ATS CV temizlensin mi?', message: 'Bu sürüm arşivlenir; gönderilmiş başvurular etkilenmez, orijinal CV’n olduğu gibi kalır.', confirmLabel: 'Temizle' });
    if (ok) await run(() => homeApi.discardAts(doc.id), { success: 'ATS CV temizlendi' }).then(() => docs.refetch());
  };

  return (
    <SubSection title="ATS CV sürümleri" description="Başvururken “İyileştir” dediğinde ilana göre hazırlanan sürümler. Orijinal CV’n değişmez; her dilde bir ana ATS CV tutulur, gerektiğinde yalnızca bir ilan için ayrı sürüm üretilir.">
      {pending.length > 0 && <Notice tone="info">{pending.length} ilana özel CV diğer açık ilanlarında ana ATS CV’nden daha uyumlu. İstersen “Ana CV yap” ile yerine geçirebilirsin.</Notice>}
      <ul className="divide-y divide-line">
        {docs.data.map((doc) => (
          <AtsRow key={doc.id} doc={doc} busy={busy} onPromote={() => void promote(doc)} onDiscard={() => void discard(doc)} onOpen={() => setPreviewing(doc)} />
        ))}
      </ul>
      {previewing && <DocumentPreviewDialog doc={{ ...previewing, type: 'cv', mime: ATS_CV_MIME }} onClose={() => setPreviewing(null)} />}
    </SubSection>
  );
}
