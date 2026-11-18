import { useQuery } from '@tanstack/react-query';
import { ArrowUpDown, Building2, ChevronRight, MailCheck, MapPin, Sparkles, Users } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { homeApi } from '@/api/home';
import type { DirectoryCompany } from '@/api/types';
import { fmtDate } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { FilterChip, SearchInput } from '@/ui/controls';
import { EmptyState, LoadError, LoadingBlock } from '@/ui/feedback';
import { Select } from '@/ui/fields';
import { Notice } from '@/ui/Notice';
import { Panel } from '@/ui/Panel';
import { useCompanyDecisions } from '../home/use-company-decisions';
import { DIRECTORY_FILTERS, DIRECTORY_SORTS, FILTER_LABELS, filterDirectory, lastApplyText, parseView, SORT_LABELS, writeView, type DirectoryFilter, type DirectorySort, type DirectoryView } from './directory-model';

const DIRECTORY_QUERY = ['home', 'directory'] as const;
const PAGE_SIZE = 100;

function CompanyRow({ company }: { company: DirectoryCompany }) {
  const applied = lastApplyText(company.lastAppliedAt);
  return (
    <li>
      <Link to={`/sirketler/${company.id}`} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 transition-colors hover:bg-sunken">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium break-words">{company.name}</span>
            {company.newSinceApply > 0 && (
              <Badge tone="warn" icon={<Sparkles className="size-3" aria-hidden />}>
                {company.newSinceApply} yeni ilan
              </Badge>
            )}
            {company.replies > 0 && (
              <Badge tone="good" icon={<MailCheck className="size-3" aria-hidden />}>
                {company.replies} yanıt
              </Badge>
            )}
            {company.hasOpportunity && company.applications === 0 && <Badge tone="info">Başvurulabilir</Badge>}
          </div>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-soft">
            {applied ? <span className="font-medium text-ink">{applied}</span> : <span>Hiç başvurulmadı</span>}
            <span>
              {company.openJobs} açık / {company.totalJobs} ilan
            </span>
            {company.lastJobAt && <span>Son ilan {fmtDate(company.lastJobAt)}</span>}
            {company.cities.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3" aria-hidden />
                {company.cities.join(', ')}
              </span>
            )}
            {company.employees && (
              <span className="inline-flex items-center gap-1">
                <Users className="size-3" aria-hidden />
                {company.employees.range}
              </span>
            )}
          </p>
        </div>
        <ChevronRight className="size-4 shrink-0 text-ink-faint" aria-hidden />
      </Link>
    </li>
  );
}

/** Başvurulmuş olanlar dahil tüm firmalar: son başvuru, yanıtlar ve başvurudan sonra açılan ilanlar. */
export function DirectoryPage() {
  const [params, setParams] = useSearchParams();
  const view = useMemo(() => parseView(params), [params]);
  const setView = useCallback((next: Partial<DirectoryView>) => setParams((current) => writeView(current, { ...parseView(current), ...next }), { replace: true }), [setParams]);
  const directory = useQuery({ queryKey: DIRECTORY_QUERY, queryFn: homeApi.directory });
  const decisions = useCompanyDecisions();
  const companies = useMemo(() => (directory.data ? filterDirectory(directory.data.companies, view) : []), [directory.data, view]);
  const [shownFor, setShownFor] = useState({ key: '', limit: PAGE_SIZE });
  const viewKey = params.toString();
  const limit = shownFor.key === viewKey ? shownFor.limit : PAGE_SIZE;
  const totals = directory.data?.totals;
  const counts: Record<DirectoryFilter, number | undefined> = {
    tum: totals?.companies,
    basvurdum: totals?.applied,
    'yeni-ilan': totals?.newSinceApply,
    'yanit-var': totals?.replied,
    basvurmadim: totals ? totals.companies - totals.applied : undefined,
  };

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold">Şirketler</h1>
        <p className="text-sm text-ink-soft">Kayıtlı tüm firmalar: ilanları, başvuruların, yazışmaların ve son başvurundan sonra yeniden ilan açılıp açılmadığı.</p>
      </header>
      {(decisions.data?.length ?? 0) > 0 && (
        <Notice
          tone="warn"
          icon={<Building2 className="size-5 shrink-0" aria-hidden />}
          action={
            <Link to="/?karar=1" className="text-sm font-medium text-brand hover:underline">
              Karar ver
            </Link>
          }
        >
          {decisions.data!.length} yeni firma adı kayıtlı bir firmaya benziyor; ilanları kararını bekliyor.
        </Notice>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput className="min-w-56 flex-1" shortcut value={view.query} onChange={(query) => setView({ query })} label="Şirketlerde ara" placeholder="Firma adı, eski adı, şehir ya da sektör" />
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <ArrowUpDown className="size-4" aria-hidden />
          <span className="sr-only">Sıralama</span>
          <Select className="w-auto" value={view.sort} onChange={(e) => setView({ sort: e.target.value as DirectorySort })}>
            {DIRECTORY_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {SORT_LABELS[sort]}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-0.5" role="group" aria-label="Durum">
        {DIRECTORY_FILTERS.map((filter) => (
          <FilterChip key={filter} active={view.filter === filter} onToggle={() => setView({ filter: view.filter === filter && filter !== 'tum' ? 'tum' : filter })} count={counts[filter]}>
            {FILTER_LABELS[filter]}
          </FilterChip>
        ))}
      </div>
      {directory.isError ? (
        <LoadError label="Şirketler" onRetry={() => void directory.refetch()} />
      ) : !directory.data ? (
        <LoadingBlock label="Şirketler yükleniyor…" />
      ) : companies.length === 0 ? (
        <Panel>
          <EmptyState icon={<Building2 aria-hidden />}>{directory.data.companies.length ? 'Bu arama ve filtreyle eşleşen firma yok.' : 'Henüz kayıtlı firma yok.'}</EmptyState>
        </Panel>
      ) : (
        <>
          <ul className="flex flex-col gap-2" aria-label="Firmalar">
            {companies.slice(0, limit).map((c) => (
              <CompanyRow key={c.id} company={c} />
            ))}
          </ul>
          {companies.length > limit && (
            <Button variant="outline" className="self-center" onClick={() => setShownFor({ key: viewKey, limit: limit + PAGE_SIZE })}>
              Daha fazla göster ({companies.length - limit} firma kaldı)
            </Button>
          )}
        </>
      )}
    </div>
  );
}
