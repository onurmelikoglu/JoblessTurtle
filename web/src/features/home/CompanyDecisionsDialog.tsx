import { Building2, Combine, Plus } from 'lucide-react';
import { homeApi } from '@/api/home';
import { useAction } from '@/api/queries';
import type { CompanyDecisionView } from '@/api/types';
import { fmtAgo, hostOf } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { EmptyState, LoadingBlock } from '@/ui/feedback';
import { useCompanyDecisions } from './use-company-decisions';


function DecisionRow({ decision, busy, onDecide }: { decision: CompanyDecisionView; busy: boolean; onDecide: (action: 'merge' | 'separate') => void }) {
  const { suggested } = decision;
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-line p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <p className="text-xs text-ink-soft">Yeni gelen ad</p>
          <p className="font-medium break-words">{decision.name}</p>
          <p className="mt-1 text-xs text-ink-soft">
            {decision.listingCount} ilan bekliyor: {decision.titles.join(', ')}
            {decision.listingCount > decision.titles.length ? '…' : ''}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-xs text-ink-soft">Kayıtlı firma</p>
          <p className="font-medium break-words">{suggested.name}</p>
          <p className="mt-1 text-xs text-ink-soft">{[suggested.website && hostOf(suggested.website), `${suggested.openJobs} açık ilan`, suggested.applications > 0 && `${suggested.applications} başvuru`].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warn">Olası aynı</Badge>
        <span className="text-xs text-ink-soft">{decision.reasons.join(' · ')}</span>
        <span className="ml-auto text-xs text-ink-faint">{fmtAgo(decision.createdAt)}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="tonal" disabled={busy} icon={<Combine className="size-4" aria-hidden />} onClick={() => onDecide('merge')}>
          {suggested.name} firmasına ekle
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} icon={<Plus className="size-4" aria-hidden />} onClick={() => onDecide('separate')}>
          Farklı firma, yeni ekle
        </Button>
      </div>
    </li>
  );
}

/**
 * Kayıtlı bir firmaya benzeyen yeni firmaların bekletilen ilanları. "Firmaya ekle" ilanları kayıtlı firmaya bağlar ve
 * aynı ad bir daha sorulmaz; "farklı firma" yeni kayıt açar.
 */
export function CompanyDecisionsDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const decisions = useCompanyDecisions();
  const { busy, run } = useAction();
  const decide = (decision: CompanyDecisionView, action: 'merge' | 'separate') =>
    run(() => homeApi.decideCompany(decision.id, action), { success: action === 'merge' ? `İlanlar ${decision.suggested.name} firmasına eklendi` : `${decision.name} yeni firma olarak eklendi` }).then(() => {
      void decisions.refetch();
      onChanged();
    });
  return (
    <Dialog
      open
      onClose={onClose}
      locked={busy}
      size="lg"
      title="Firma kararı bekleyen ilanlar"
      description="Bu ilanların firması kayıtlı bir firmaya çok benziyor. Aynı firmaysa ilanlar kayıtlı firmaya eklenir; değilse yeni firma açılır. Karar verilmeyen ilanlar 14 gün sonra düşer."
    >
      {!decisions.data ? (
        <LoadingBlock label="Kararlar yükleniyor…" />
      ) : decisions.data.length === 0 ? (
        <EmptyState icon={<Building2 aria-hidden />}>Karar bekleyen ilan kalmadı.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {decisions.data.map((d) => (
            <DecisionRow key={d.id} decision={d} busy={busy} onDecide={(action) => void decide(d, action)} />
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export interface SimilarPrompt {
  query: string;
  match: { id: string; name: string; reasons: string[] };
}

/** Kurum eklemeden önce: yazılan ada benzeyen kayıtlı firma varsa o mu, yoksa yeni mi eklensin? */
export function SimilarCompanyDialog({ prompt, onExisting, onNew, onClose }: { prompt: SimilarPrompt; onExisting: () => void; onNew: () => void; onClose: () => void }) {
  return (
    <Dialog
      open
      size="sm"
      onClose={onClose}
      title="Benzer adla kayıtlı bir firma var"
      footer={
        <>
          <Button variant="ghost" onClick={onNew}>
            Hayır, yeni ekle
          </Button>
          <Button variant="primary" onClick={onExisting}>
            Evet, onu göster
          </Button>
        </>
      }
    >
      <p className="text-sm">
        "<strong>{prompt.query}</strong>" için aradığın firma, kayıtlı olan <strong>{prompt.match.name}</strong> olabilir.
      </p>
      <p className="mt-2 text-xs text-ink-soft">{prompt.match.reasons.join(' · ')}</p>
    </Dialog>
  );
}
