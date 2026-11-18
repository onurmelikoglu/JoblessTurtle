import { Combine } from 'lucide-react';
import { useMemo, useState } from 'react';
import { homeApi } from '@/api/home';
import { useAction } from '@/api/queries';
import type { CompanyTwin, HomeCompany } from '@/api/types';
import { fold } from '@/lib/text';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { SearchInput } from '@/ui/controls';
import { Dialog } from '@/ui/Dialog';
import { EmptyState } from '@/ui/feedback';

const MAX_CANDIDATES = 8;

function KeepChoice({ name, options, value, onChange }: { name: string; options: { id: string; name: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <fieldset className="flex flex-col gap-1 text-sm">
      <legend className="mb-1 text-xs text-ink-soft">Kalacak ad</legend>
      {options.map((o) => (
        <label key={o.id} className="flex items-center gap-2">
          <input type="radio" name={name} checked={value === o.id} onChange={() => onChange(o.id)} />
          <span className="break-words">{o.name}</span>
        </label>
      ))}
    </fieldset>
  );
}

function TwinRow({ twin, busy, onMerge, onDismiss }: { twin: CompanyTwin; busy: boolean; onMerge: (keepId: string, dropId: string) => void; onDismiss: () => void }) {
  const [keep, setKeep] = useState(twin.a.id);
  const drop = keep === twin.a.id ? twin.b.id : twin.a.id;
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={twin.level === 'certain' ? 'good' : 'warn'}>{twin.level === 'certain' ? 'Kesin aynı' : 'Olası aynı'}</Badge>
        <span className="text-xs text-ink-soft">{twin.reasons.join(' · ')}</span>
      </div>
      <KeepChoice name={`keep-${twin.a.id}-${twin.b.id}`} options={[twin.a, twin.b]} value={keep} onChange={setKeep} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="tonal" disabled={busy} icon={<Combine className="size-4" aria-hidden />} onClick={() => onMerge(keep, drop)}>
          Birleştir
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>
          Farklı firmalar
        </Button>
      </div>
    </li>
  );
}

/** Aynı firmanın olası kayıtları: kullanıcı birleştirir ya da farklı firmalar olduğunu söyler. */
export function TwinsDialog({ twins, onClose, onChanged }: { twins: CompanyTwin[]; onClose: () => void; onChanged: () => void }) {
  const { busy, run } = useAction();
  const merge = (keepId: string, dropId: string) => run(() => homeApi.mergeCompanies(keepId, dropId), { success: 'Firmalar birleştirildi' }).then(onChanged);
  const dismiss = (t: CompanyTwin) => run(() => homeApi.dismissTwin(t.a.id, t.b.id), { success: 'Ayrı firmalar olarak bırakıldı', refresh: false }).then(onChanged);
  return (
    <Dialog open onClose={onClose} locked={busy} size="lg" title="Aynı firmanın kayıtları" description="Farklı ilan sitelerinde aynı firma farklı adla geçebilir. Birleştirince ilanlar, adresler ve başvurular tek kayıtta toplanır; aynı ilan tek ilana iner.">
      {twins.length === 0 ? (
        <EmptyState icon={<Combine aria-hidden />}>İncelenecek çift kayıt kalmadı.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {twins.map((t) => (
            <TwinRow key={`${t.a.id}|${t.b.id}`} twin={t} busy={busy} onMerge={(keep, drop) => void merge(keep, drop)} onDismiss={() => void dismiss(t)} />
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** Bir firmayı listedeki başka bir firmayla elle birleştirme. */
export function MergeWithDialog({ company, companies, onClose, onChanged }: { company: HomeCompany; companies: HomeCompany[]; onClose: () => void; onChanged: () => void }) {
  const { busy, run } = useAction();
  const [query, setQuery] = useState(company.name.split(' ')[0] ?? '');
  const [other, setOther] = useState<HomeCompany | null>(null);
  const [keep, setKeep] = useState(company.id);
  const candidates = useMemo(() => {
    const q = fold(query.trim());
    return q ? companies.filter((c) => c.id !== company.id && fold(c.name).includes(q)).slice(0, MAX_CANDIDATES) : [];
  }, [companies, company.id, query]);
  const merge = () => other && run(() => homeApi.mergeCompanies(keep, keep === company.id ? other.id : company.id), { success: 'Firmalar birleştirildi' }).then(() => (onChanged(), onClose()));
  return (
    <Dialog
      open
      onClose={onClose}
      locked={busy}
      title={`${company.name} ile birleştir`}
      footer={
        <>
          <span className="flex-1" />
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Vazgeç
          </Button>
          <Button variant="primary" disabled={busy || !other} icon={<Combine className="size-4" aria-hidden />} onClick={() => void merge()}>
            Birleştir
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <SearchInput value={query} onChange={(q) => (setQuery(q), setOther(null))} label="Firma ara" placeholder="Aynı firmanın diğer kaydını ara" />
        <ul className="flex flex-col gap-1">
          {candidates.map((c) => (
            <li key={c.id}>
              <label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-sunken">
                <input type="radio" name="merge-with" checked={other?.id === c.id} onChange={() => setOther(c)} />
                <span className="min-w-0 break-words">{c.name}</span>
                <span className="ml-auto shrink-0 text-xs text-ink-soft">{c.cities.join(', ')}</span>
              </label>
            </li>
          ))}
          {query.trim() && candidates.length === 0 && <li className="text-sm text-ink-soft">Bu adla başka firma yok.</li>}
        </ul>
        {other && <KeepChoice name="merge-keep" options={[company, other]} value={keep} onChange={setKeep} />}
      </div>
    </Dialog>
  );
}
