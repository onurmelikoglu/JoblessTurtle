import { ArrowUpDown, FileText, Globe, MailCheck, MailX, MapPin, Search, Users, X } from 'lucide-react';
import type { CompanyClass, HomeCompanies } from '@/api/types';
import { FilterChip, SearchInput } from '@/ui/controls';
import { Select } from '@/ui/fields';
import { activeFilterCount, DEFAULT_FILTERS, SCOPE_FILTERS, SIZE_BUCKETS, UNKNOWN_SIZE, type CompanyFilters, type CompanySort, type EmailFilter, type ScopeFilter, type SizeBucket } from './company-filters';
import { CLASS_INFO, COMPANY_CLASS_ORDER } from './model';

const SORT_LABELS: Record<CompanySort, string> = { recommended: 'Önerilen sıra', newest: 'En yeni bulunan', name: 'Firma adı (A-Z)' };
const SCOPE_LABELS: Record<ScopeFilter, { label: string; hint: string }> = {
  tr: { label: 'Türkiye', hint: "Türkiye'deki ilanlar ve firmaya genel başvurular" },
  uzaktan: { label: 'Uzaktan', hint: 'Uzaktan çalışılabilen ilanlar' },
  yurtdisi: { label: 'Yurt dışı', hint: 'Taşınmayı gerektiren yurt dışı ilanları' },
};
const SIZE_LABELS: Record<SizeBucket, string> = { '1-10': '1-10', '11-50': '11-50', '51-200': '51-200', '201-1000': '201-1.000', '1000+': '1.000+', bilinmiyor: 'Bilinmiyor' };

interface CompanyToolbarProps {
  filters: CompanyFilters;
  onChange: (filters: CompanyFilters) => void;
  totals: HomeCompanies['totals'];
  sizes: Record<SizeBucket, number>;
  scopes: Record<ScopeFilter, number>;
  shown: number;
  busy: boolean;
  onFindSizes: () => void;
}

export function CompanyToolbar({ filters, onChange, totals, sizes, scopes, shown, busy, onFindSizes }: CompanyToolbarProps) {
  const patch = (next: Partial<CompanyFilters>) => onChange({ ...filters, ...next });
  const toggleClass = (companyClass: CompanyClass) => patch({ classes: filters.classes.includes(companyClass) ? filters.classes.filter((c) => c !== companyClass) : [...filters.classes, companyClass] });
  const toggleSize = (size: SizeBucket) => patch({ sizes: filters.sizes.includes(size) ? filters.sizes.filter((s) => s !== size) : [...filters.sizes, size] });
  const toggleScope = (scope: ScopeFilter) => patch({ scopes: filters.scopes.includes(scope) ? filters.scopes.filter((s) => s !== scope) : [...filters.scopes, scope] });
  const showScopes = scopes.uzaktan + scopes.yurtdisi > 0 || filters.scopes.length > 0;
  const toggleEmail = (value: EmailFilter) => patch({ email: filters.email === value ? 'any' : value });
  const active = activeFilterCount(filters);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <SearchInput className="min-w-56 flex-1" shortcut value={filters.query} onChange={(query) => patch({ query })} label="Firmalarda ara" placeholder="Firma, pozisyon, şehir, ilçe veya sektör ara" />
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
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtreler">
        {COMPANY_CLASS_ORDER.map((companyClass) => (
          <FilterChip key={companyClass} active={filters.classes.includes(companyClass)} onToggle={() => toggleClass(companyClass)} count={totals.byClass[companyClass]} title={CLASS_INFO[companyClass].hint}>
            {CLASS_INFO[companyClass].short}
          </FilterChip>
        ))}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <FilterChip active={filters.inRegion} onToggle={() => patch({ inRegion: !filters.inRegion })} icon={<MapPin className="size-3.5" aria-hidden />} title="Seçtiğin şehirlerde ofisi olan firmalar">
          Bölgemde
        </FilterChip>
        <FilterChip active={filters.email === 'has'} onToggle={() => toggleEmail('has')} icon={<MailCheck className="size-3.5" aria-hidden />} title="Başvuru gönderilebilecek mail adresi bulunanlar">
          Mail adresi var
        </FilterChip>
        <FilterChip active={filters.email === 'missing'} onToggle={() => toggleEmail('missing')} icon={<MailX className="size-3.5" aria-hidden />} title="Mail adresi bulunamayanlar; form ya da ilan sitesinden başvurulur">
          Mail adresi yok
        </FilterChip>
        <FilterChip active={filters.ready} onToggle={() => patch({ ready: !filters.ready })} icon={<FileText className="size-3.5" aria-hidden />} title="Başvuru yazısı hazır ve sorunsuz olanlar">
          Yazısı hazır
        </FilterChip>
      </div>
      {showScopes && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="İlan kapsamı">
          <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink-soft">
            <Globe className="size-3.5" aria-hidden />
            Kapsam
          </span>
          {SCOPE_FILTERS.map((scope) => (
            <FilterChip key={scope} active={filters.scopes.includes(scope)} onToggle={() => toggleScope(scope)} count={scopes[scope]} title={SCOPE_LABELS[scope].hint}>
              {SCOPE_LABELS[scope].label}
            </FilterChip>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Çalışan sayısı">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink-soft">
          <Users className="size-3.5" aria-hidden />
          Çalışan sayısı
        </span>
        {SIZE_BUCKETS.map((size) => (
          <FilterChip key={size} active={filters.sizes.includes(size)} onToggle={() => toggleSize(size)} count={sizes[size]} title={size === UNKNOWN_SIZE ? 'Çalışan sayısı henüz öğrenilemeyen firmalar' : `${SIZE_LABELS[size]} çalışanı olan firmalar`}>
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
      </div>
      <p className="flex min-h-6 flex-wrap items-center gap-x-3 text-sm text-ink-soft" aria-live="polite">
        {active > 0 ? `${totals.companies} firmadan ${shown} tanesi gösteriliyor` : `${totals.companies} firma`}
        {active > 0 && (
          <button type="button" onClick={() => onChange({ ...DEFAULT_FILTERS, sort: filters.sort })} className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
            <X className="size-3.5" aria-hidden />
            Filtreleri temizle
          </button>
        )}
      </p>
    </div>
  );
}
