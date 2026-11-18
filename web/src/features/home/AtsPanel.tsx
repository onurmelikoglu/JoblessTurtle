import { FileCheck2, Plus, Wand2 } from 'lucide-react';
import { useState } from 'react';
import type { HomeAtsItem, HomeAtsOverview } from '@/api/types';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { InlineBusy } from '@/ui/feedback';
import { ATS_STATUS_TEXT, atsTone, attachedIsAts, betterVersion, needsImprovement, variantLabel } from './ats-model';

const SHOWN_TERMS = 8;

function Terms({ title, terms, tone }: { title: string; terms: string[]; tone: 'warn' | 'info' }) {
  const [all, setAll] = useState(false);
  if (!terms.length) return null;
  const shown = all ? terms : terms.slice(0, SHOWN_TERMS);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-xs text-ink-soft">{title}:</span>
      {shown.map((t) => (
        <Badge key={t} tone={tone}>
          {t}
        </Badge>
      ))}
      {terms.length > SHOWN_TERMS && (
        <button type="button" className="text-xs font-medium text-brand hover:underline" onClick={() => setAll(!all)}>
          {all ? 'daha az' : `+${terms.length - SHOWN_TERMS}`}
        </button>
      )}
    </div>
  );
}

function AtsRow({ item, threshold, busy, onAttach }: { item: HomeAtsItem; threshold: number; busy: boolean; onAttach: (id: string) => void }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={atsTone(item.score, threshold)}>%{item.score}</Badge>
        <span className="text-sm font-medium">{variantLabel(item.variant)}</span>
        <span className="truncate text-xs text-ink-soft">{item.label}</span>
        {item.attached ? (
          <Badge tone="info" className="ml-auto">
            Ekli
          </Badge>
        ) : (
          <Button variant="ghost" size="sm" className="ml-auto" disabled={busy} icon={<Plus className="size-4" aria-hidden />} onClick={() => onAttach(item.documentId)}>
            Bunu ekle
          </Button>
        )}
      </div>
      <Terms title="İlanda istenip CV'de olmayan" terms={item.missing} tone="warn" />
      <Terms title="Kanıtı olmadan eklendi" terms={item.addedSkills} tone="info" />
    </li>
  );
}

interface AtsPanelProps {
  ats: HomeAtsOverview;
  busy: boolean;
  improving: boolean;
  onImprove: () => void;
  onAttach: (documentId: string) => void;
}

/**
 * Taslaktaki CV'nin ilana ATS uyumu: dildeki her CV sürümünün oranı, eksik terimler, iyileştirmede eklenenler.
 * "İyileştir" ilana göre ATS sürümü hazırlayıp ekler; daha iyi hazır bir sürüm varsa "Bunu ekle" ile seçilir.
 */
export function AtsPanel({ ats, busy, improving, onImprove, onAttach }: AtsPanelProps) {
  if (ats.status === 'no_job') return null;
  if (ats.status !== 'ready') {
    const text = ATS_STATUS_TEXT[ats.status];
    if (!text) return null;
    return ats.status === 'preparing' ? <InlineBusy>{text}</InlineBusy> : <p className="text-xs text-ink-soft">{text}</p>;
  }
  const low = needsImprovement(ats);
  const better = betterVersion(ats);
  const rewrite = attachedIsAts(ats);
  return (
    <section aria-label="ATS uyumu" className="flex flex-col gap-2 rounded-xl border border-line bg-sunken/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <FileCheck2 className="size-4 text-ink-soft" aria-hidden />
        <h3 className="text-sm font-semibold">CV'nin ilana ATS uyumu</h3>
        {ats.attachedScore !== null && <Badge tone={atsTone(ats.attachedScore, ats.threshold)}>Ekli CV %{ats.attachedScore}</Badge>}
        <span className="text-xs text-ink-soft">eşik %{ats.threshold}</span>
        <Button variant={low ? 'primary' : 'outline'} size="sm" className="ml-auto" loading={improving} disabled={busy && !improving} icon={<Wand2 className="size-4" aria-hidden />} onClick={onImprove} title={rewrite ? 'Ekli ATS CV ilana göre yeniden yazılır ve eskisinin yerine geçer' : undefined}>
          {rewrite ? 'Yeniden iyileştir' : 'İyileştir'}
        </Button>
      </div>
      {improving && <InlineBusy>CV ilana göre iyileştiriliyor; orijinal CV'n değişmez (1-2 dk)…</InlineBusy>}
      {low && !improving && <p className="text-xs text-warn">{better ? `Hazır bir sürüm daha uyumlu (%${better.score}); onu ekleyebilir ya da "İyileştir" ile yenisini hazırlatabilirsin.` : 'Ekli CV eşiğin altında. "İyileştir" ilana uygun bir ATS sürümü hazırlar.'}</p>}
      <ul className="flex flex-col gap-1.5">
        {ats.items.map((item) => (
          <AtsRow key={item.documentId} item={item} threshold={ats.threshold} busy={busy} onAttach={onAttach} />
        ))}
      </ul>
    </section>
  );
}
