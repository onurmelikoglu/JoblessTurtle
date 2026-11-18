import { ArrowUpDown, Briefcase, FileText, Globe, MailCheck, MailX, MapPin, Search, SlidersHorizontal, Users, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CompanyClass, HomeCompanies } from '@/api/types';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/Button';
import { FilterChip, SearchInput } from '@/ui/controls';
import { Select } from '@/ui/fields';
import { Popover } from '@/ui/Popover';
import {
  activeFilterCount,
  activeFilterPills,
  DEFAULT_FILTERS,
  REGION_ANY,
  REGION_OTHER,
  REGION_OTHER_LABEL,
  regionSlug,
  SCOPE_FILTERS,
  SCOPE_LABELS,
  SIZE_BUCKETS,
  SIZE_LABELS,
  UNKNOWN_SIZE,
  WORK_MODE_FILTERS,
  WORK_MODE_LABELS,
  type CompanyFilters,
  type CompanySort,
  type EmailFilter,
  type ScopeFilter,
  type SizeBucket,
  type WorkModeFilter,
} from './company-filters';
import { JobSiteSearch } from './JobSiteSearch';
import { CLASS_INFO, COMPANY_CLASS_ORDER } from './model';

const SORT_LABELS: Record<CompanySort, string> = { recommended: 'Önerilen sıra', newest: 'En yeni bulunan', name: 'Firma adı (A-Z)' };

interface CompanyToolbarProps {
  filters: CompanyFilters;
  onChange: (filters: CompanyFilters) => void;
  totals: HomeCompanies['totals'];
  regionLabels: string[];
  regions: Record<string, number>;
  workModes: Record<WorkModeFilter, number>;
  sizes: Record<SizeBucket, number>;
  scopes: Record<ScopeFilter, number>;
  shown: number;
  busy: boolean;
  onFindSizes: () => void;
}

function FilterGroup({ icon, title, children, className }: { icon: ReactNode; title: string; children: ReactNode; className?: string }) {
  return (
    <fieldset className={cn('flex min-w-0 flex-col gap-2', className)}>
      <legend className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-ink-soft">
        {icon}
        {title}
      </legend>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </fieldset>
  );
}

/**
 * Firmalar sekmesinin üst çubuğu: arama, sıralama ve sınıf düğmeleri her zaman görünür; bölge, çalışma şekli, kapsam,
 * çalışan sayısı ve mail/yazı filtreleri "Filtreler" panelindedir. Seçili panel filtreleri çubuğun altında tek satırda
 * kaldırılabilir etiket olarak durur.
 */
export function CompanyToolbar({ filters, onChange, totals, regionLabels, regions, workModes, sizes, scopes, shown, busy, onFindSizes }: CompanyToolbarProps) {
  const patch = (next: Partial<CompanyFilters>) => onChange({ ...filters, ...next });
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  const regionSlugs = regionLabels.map(regionSlug);
  const regionActive = (slug: string) => filters.regions.includes(slug) || (slug !== REGION_OTHER && filters.regions.includes(REGION_ANY));
  const toggleRegion = (slug: string) => {
    const current = filters.regions.includes(REGION_ANY) ? [...filters.regions.filter((r) => r !== REGION_ANY), ...regionSlugs] : filters.regions;
    patch({ regions: toggle(current, slug) });
  };
  const toggleClass = (companyClass: CompanyClass) => patch({ classes: toggle(filters.classes, companyClass) });
  const toggleEmail = (value: EmailFilter) => patch({ email: filters.email === value ? 'any' : value });
  const showScopes = scopes.uzaktan + scopes.yurtdisi > 0 || filters.scopes.length > 0;
  const active = activeFilterCount(filters);
  const pills = activeFilterPills(filters, regionLabels);
  const clearAll = () => onChange({ ...DEFAULT_FILTERS, sort: filters.sort });
  const clearPanel = () => onChange({ ...filters, regions: [], workModes: [], scopes: [], sizes: [], email: 'any', ready: false });

  const panel = (
    <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
      {regionLabels.length > 0 && (
        <FilterGroup icon={<MapPin className="size-3.5" aria-hidden />} title="Bölge" className="sm:col-span-2">
          {regionLabels.map((label, i) => (
            <FilterChip key={label} active={regionActive(regionSlugs[i])} onToggle={() => toggleRegion(regionSlugs[i])} count={regions[regionSlugs[i]] ?? 0} title={`İlanı ${label} bölgesinde olanlar; ilanda konum yoksa firmanın ofisine bakılır`}>
              {label}
            </FilterChip>
          ))}
          <FilterChip active={regionActive(REGION_OTHER)} onToggle={() => toggleRegion(REGION_OTHER)} count={regions[REGION_OTHER] ?? 0} title="Seçtiğin bölgelerin dışında kalanlar ya da konumu bilinmeyenler">
            {REGION_OTHER_LABEL}
          </FilterChip>
        </FilterGroup>
      )}
      <FilterGroup icon={<Briefcase className="size-3.5" aria-hidden />} title="Çalışma şekli">
        {WORK_MODE_FILTERS.map((mode) => (
          <FilterChip key={mode} active={filters.workModes.includes(mode)} onToggle={() => patch({ workModes: toggle(filters.workModes, mode) })} count={workModes[mode]} title={WORK_MODE_LABELS[mode].hint}>
            {WORK_MODE_LABELS[mode].label}
          </FilterChip>
        ))}
      </FilterGroup>
      {showScopes && (
        <FilterGroup icon={<Globe className="size-3.5" aria-hidden />} title="Kapsam">
          {SCOPE_FILTERS.map((scope) => (
            <FilterChip key={scope} active={filters.scopes.includes(scope)} onToggle={() => patch({ scopes: toggle(filters.scopes, scope) })} count={scopes[scope]} title={SCOPE_LABELS[scope].hint}>
              {SCOPE_LABELS[scope].label}
            </FilterChip>
          ))}
        </FilterGroup>
      )}
      <FilterGroup icon={<Users className="size-3.5" aria-hidden />} title="Çalışan sayısı">
        {SIZE_BUCKETS.map((size) => (
          <FilterChip key={size} active={filters.sizes.includes(size)} onToggle={() => patch({ sizes: toggle(filters.sizes, size) })} count={sizes[size]} title={size === UNKNOWN_SIZE ? 'Çalışan sayısı henüz öğrenilemeyen firmalar' : `${SIZE_LABELS[size]} çalışanı olan firmalar`}>
            {SIZE_LABELS[size]}
          </FilterChip>
        ))}
        {totals.sizeUnknown > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={onFindSizes}
            title="Çalışan sayısı bilinmeyen firmalar web'de aranır; başka bir kullanıcıda bilinenler aranmadan gelir"
            className="inline-flex h-8 items-center gap-1 px-1 text-[13px] font-medium text-brand hover:underline disabled:opacity-50"
          >
            <Search className="size-3.5" aria-hidden />
            Bilinmeyenleri bul
          </button>
        )}
      </FilterGroup>
      <FilterGroup icon={<MailCheck className="size-3.5" aria-hidden />} title="Başvuru durumu">
        <FilterChip active={filters.email === 'has'} onToggle={() => toggleEmail('has')} icon={<MailCheck className="size-3.5" aria-hidden />} title="Başvuru gönderilebilecek mail adresi bulunanlar">
          Mail adresi var
        </FilterChip>
        <FilterChip active={filters.email === 'missing'} onToggle={() => toggleEmail('missing')} icon={<MailX className="size-3.5" aria-hidden />} title="Mail adresi bulunamayanlar; form ya da ilan sitesinden başvurulur">
          Mail adresi yok
        </FilterChip>
        <FilterChip active={filters.ready} onToggle={() => patch({ ready: !filters.ready })} icon={<FileText className="size-3.5" aria-hidden />} title="Başvuru yazısı hazır ve sorunsuz olanlar">
          Yazısı hazır
        </FilterChip>
      </FilterGroup>
      {pills.length > 0 && (
        <div className="flex justify-end sm:col-span-2">
          <Button variant="ghost" size="sm" icon={<X className="size-4" aria-hidden />} onClick={clearPanel}>
            Bu paneldeki seçimleri temizle
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput className="min-w-56 flex-1" shortcut value={filters.query} onChange={(query) => patch({ query })} label="Firmalarda ara" placeholder="Firma, pozisyon, şehir, ilçe veya sektör ara" />
        <Popover
          title="Filtreler"
          trigger={
            <Button variant={pills.length > 0 ? 'tonal' : 'outline'} icon={<SlidersHorizontal className="size-4" aria-hidden />} aria-label={pills.length > 0 ? `Filtreler, ${pills.length} seçili` : 'Filtreler'}>
              Filtreler
              {pills.length > 0 && <span className="rounded-full bg-brand px-1.5 text-[11px] leading-5 font-semibold text-on-brand tabular-nums">{pills.length}</span>}
            </Button>
          }
        >
          {panel}
        </Popover>
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <ArrowUpDown className="size-4" aria-hidden />
          <span className="sr-only">Sıralama</span>
          <Select className="w-auto" value={filters.sort} onChange={(e) => patch({ sort: e.target.value as CompanySort })}>
            {(Object.keys(SORT_LABELS) as CompanySort[]).map((sort) => (
              <option key={sort} value={sort}>
                {SORT_LABELS[sort]}
              </option>
            ))}
          </Select>
        </label>
        <JobSiteSearch />
      </div>
      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-0.5" role="group" aria-label="Firma sınıfı">
        {COMPANY_CLASS_ORDER.map((companyClass) => (
          <FilterChip key={companyClass} active={filters.classes.includes(companyClass)} onToggle={() => toggleClass(companyClass)} count={totals.byClass[companyClass]} title={CLASS_INFO[companyClass].hint}>
            {CLASS_INFO[companyClass].short}
          </FilterChip>
        ))}
      </div>
      <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink-soft" aria-live="polite">
        <span>{active > 0 ? `${totals.companies} firmadan ${shown} tanesi gösteriliyor` : `${totals.companies} firma`}</span>
        {pills.map((pill) => (
          <button
            key={pill.key}
            type="button"
            onClick={() => onChange(pill.without)}
            aria-label={`${pill.label} filtresini kaldır`}
            className="inline-flex h-7 items-center gap-1 rounded-full border border-brand/40 bg-brand-soft pr-1.5 pl-2.5 text-[12px] font-medium text-brand-strong hover:bg-brand/20"
          >
            {pill.label}
            <X className="size-3.5" aria-hidden />
          </button>
        ))}
        {active > 0 && (
          <button type="button" onClick={clearAll} className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
            Tümünü temizle
          </button>
        )}
      </div>
    </div>
  );
}
