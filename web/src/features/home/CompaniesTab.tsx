import { BellRing, Building2, Combine, Languages, Plus, Radar, Search, Send } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { homeApi } from '@/api/home';
import { useAction, useRefreshHome } from '@/api/queries';
import type { HomeCompanies, HomeCompany, HomeOpportunity, HomeState } from '@/api/types';
import { fold } from '@/lib/text';
import { useNow } from '@/lib/use-now';
import { idsOf, LINK_PARAMS, withoutParams } from '@/notification-links';
import { Button } from '@/ui/Button';
import { useConfirm } from '@/ui/confirm-context';
import { EmptyState, InlineBusy, LoadingBlock } from '@/ui/feedback';
import { Checkbox } from '@/ui/fields';
import { Notice } from '@/ui/Notice';
import { Panel } from '@/ui/Panel';
import { toast } from '@/ui/toast';
import { ApplyPreviewDialog } from './ApplyPreviewDialog';
import { BulkReviewDialog } from './BulkReviewDialog';
import { CompanyCard, type CompanyCardActions } from './CompanyCard';
import { activeFilterCount, filterCompanies, focusCompanies, groupByClass, isFocused, parseFilters, regionCounts, scopeCounts, sizeCounts, workModeCounts, writeFilters, type CompanyFilters, type CompanyFocus } from './company-filters';
import { CompanyToolbar } from './CompanyToolbar';
import { JobSiteSearch } from './JobSiteSearch';
import { MergeWithDialog, TwinsDialog } from './MergeDialogs';
import { ResearchProgress } from './ResearchProgress';
import { useCompanyTwins } from './use-company-twins';
import { CLASS_INFO, foundSummary, hasEmail } from './model';

const PAGE_SIZE = 40;
const LOOKUP_POLL_MS = 5000;
const EMAIL_SEARCH_TIMEOUT_MS = 40 * 60_000;
const BATCH_POLL_RUNNING_MS = 5000;
const BATCH_POLL_IDLE_MS = 60_000;
const OFFICE_SEARCH_TIMEOUT_MS = 6 * 60_000;
const MIN_LOOKUP_LENGTH = 2;
const MIN_SCAN_LENGTH = 3;
const SIZE_SEARCH_GROUP = 12;
const FOCUS_PARAMS = [LINK_PARAMS.jobs, LINK_PARAMS.opportunities];

interface CompaniesTabProps {
  data: HomeCompanies | undefined;
  state: HomeState;
}

function useCompanyLookups(onFound: (name: string) => void) {
  const [lookups, setLookups] = useState<Record<string, string>>({});
  const refresh = useRefreshHome();
  const found = useRef(onFound);
  useEffect(() => {
    found.current = onFound;
  }, [onFound]);

  useEffect(() => {
    const ids = Object.keys(lookups);
    if (ids.length === 0) return;
    const timer = window.setInterval(async () => {
      for (const id of ids) {
        const result = await homeApi.lookupStatus(id).catch(() => null);
        if (!result || result.status === 'pending') continue;
        const asked = lookups[id];
        setLookups(({ [id]: _done, ...rest }) => rest);
        if (result.status === 'added') toast.success(`${result.name} eklendi${result.openRoles ? `; ${result.openRoles} açık ilan bulundu, kariyer sayfası taranıyor` : '; firma araştırılıyor'}`);
        else if (result.status === 'exists') toast.info(`${result.name} zaten listendeydi; bilgileri yeniden araştırılıyor`);
        else if (result.status === 'not_found') toast.warn(`"${asked}" adlı bir kurum bulunamadı; adını farklı yazmayı dene`);
        else toast.warn(`"${asked}" aranamadı: ${result.reason ?? 'AI şu an kullanılamıyor'}`);
        if (result.name) found.current(result.name);
        void refresh();
      }
    }, LOOKUP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [lookups, refresh]);

  const start = useCallback((lookupId: string, name: string) => setLookups((current) => ({ ...current, [lookupId]: name })), []);
  return { pending: Object.values(lookups), start };
}

/** Görünür alana yaklaşıldıkça listeyi sayfa sayfa büyütür; yüzlerce kartı tek seferde çizmez. */
function useGrowingLimit(resetKey: string, total: number) {
  const [grown, setGrown] = useState({ key: resetKey, limit: PAGE_SIZE });
  const limit = grown.key === resetKey ? grown.limit : PAGE_SIZE;
  const sentinel = useRef<HTMLDivElement>(null);
  const showMore = useCallback(() => setGrown((current) => (current.key !== resetKey ? { key: resetKey, limit: PAGE_SIZE * 2 } : current.limit < total ? { key: resetKey, limit: current.limit + PAGE_SIZE } : current)), [resetKey, total]);
  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && showMore(), { rootMargin: '600px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [limit, showMore]);
  return { limit, sentinel, showMore };
}

export function CompaniesTab({ data, state }: CompaniesTabProps) {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  const focus = useMemo<CompanyFocus>(() => ({ jobs: idsOf(params, LINK_PARAMS.jobs), opportunities: idsOf(params, LINK_PARAMS.opportunities) }), [params]);
  const focused = isFocused(focus);
  const setFilters = useCallback((next: CompanyFilters) => setParams((current) => writeFilters(withoutParams(current, ...FOCUS_PARAMS), next), { replace: true }), [setParams]);
  const clearFocus = () => setParams((current) => withoutParams(current, ...FOCUS_PARAMS), { replace: true });
  const { busy, run } = useAction();
  const refreshHome = useRefreshHome();
  const confirm = useConfirm();
  const now = useNow();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [applying, setApplying] = useState<ReadonlySet<string>>(new Set());
  const [research, setResearch] = useState<Record<string, number>>({});
  const [openAnalysis, setOpenAnalysis] = useState<ReadonlySet<string>>(new Set());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [bulkItems, setBulkItems] = useState<HomeOpportunity[] | null>(null);
  const twins = useCompanyTwins();
  const [twinsOpen, setTwinsOpen] = useState(false);
  const [mergeId, setMergeId] = useState<string | null>(null);
  const afterMerge = () => {
    void twins.refetch();
    void refreshHome();
  };
  const lookups = useCompanyLookups((name) => setFilters({ ...filters, query: name }));

  const companies = useMemo(() => data?.companies ?? [], [data]);
  const sizes = useMemo(() => sizeCounts(companies), [companies]);
  const scopes = useMemo(() => scopeCounts(companies), [companies]);
  const regions = useMemo(() => regionCounts(companies), [companies]);
  const workModes = useMemo(() => workModeCounts(companies), [companies]);
  const [scanned, setScanned] = useState<ReadonlySet<string>>(new Set());
  const filtered = useMemo(() => (focused ? focusCompanies(companies, focus) : filterCompanies(companies, filters)), [companies, filters, focus, focused]);
  const { limit, sentinel, showMore } = useGrowingLimit(params.toString(), filtered.length);
  const shown = filtered.slice(0, limit);
  const focusedCount = focused ? filtered.reduce((sum, c) => sum + c.opportunities.length, 0) : 0;
  const focusSize = focus.jobs.length + focus.opportunities.length;
  const opportunities = useMemo(() => filtered.flatMap((c) => c.opportunities), [filtered]);
  const selectable = useMemo(() => opportunities.filter((o) => hasEmail(o) && !applying.has(o.id)), [opportunities, applying]);
  const selectableIds = useMemo(() => new Set(selectable.map((o) => o.id)), [selectable]);
  const chosen = useMemo(() => new Set([...selected].filter((id) => selectableIds.has(id))), [selected, selectableIds]);
  const missingEmail = opportunities.filter((o) => !hasEmail(o));
  const batch = useQuery({ queryKey: ['home', 'research-batch'], queryFn: homeApi.researchBatch, refetchInterval: (query) => (query.state.data?.status === 'running' ? BATCH_POLL_RUNNING_MS : BATCH_POLL_IDLE_MS) });
  const batchRunning = batch.data?.status === 'running';
  const inBatch = useMemo(() => new Set(batchRunning ? batch.data!.activeCompanyIds : []), [batch.data, batchRunning]);
  const batchFinished = batch.data?.finished ?? 0;
  useEffect(() => {
    if (batchFinished > 0) void refreshHome();
  }, [batchFinished, refreshHome]);
  const missingOffice = filtered.filter((c) => c.offices.length === 0).length;
  const missingSize = filtered.filter((c) => !c.employees).length;
  const needsResearch = filtered.filter((c) => !inBatch.has(c.id) && (c.opportunities.some((o) => !hasEmail(o)) || c.offices.length === 0 || !c.employees));
  const allChosen = selectable.length > 0 && chosen.size === selectable.length;
  const mailMissing = state.setup.missing.includes('mail');
  const englishWithoutCv = state.setup.english.cv ? 0 : companies.filter((c) => c.opportunities.some((o) => o.language === 'en')).length;
  const query = filters.query.trim();
  const exactMatch = companies.some((c) => fold(c.name) === fold(query));

  const isResearching = (company: HomeCompany) => {
    if (inBatch.has(company.id)) return true;
    const startedAt = research[company.id];
    if (!startedAt) return false;
    const age = now - startedAt;
    const waitingEmail = company.opportunities.some((o) => !hasEmail(o)) && age < EMAIL_SEARCH_TIMEOUT_MS;
    const waitingOffice = company.offices.length === 0 && age < OFFICE_SEARCH_TIMEOUT_MS;
    return waitingEmail || waitingOffice;
  };

  const closeDialog = (sent: boolean, ids: string[]) => {
    setPreviewId(null);
    setBulkItems(null);
    void refreshHome();
    if (!sent) return;
    setApplying((current) => new Set([...current, ...ids]));
    setSelected(new Set());
    toast.success('Başvuru sıraya alındı. Gönderildikçe "Başvurularım" sekmesinde görünecek.');
  };

  const applyTo = (items: HomeOpportunity[]) => {
    if (items.length === 0) return;
    if (mailMissing) return toast.error('Başvuru gönderebilmek için önce Profilim sayfasından mail hesabını bağla');
    if (items.length === 1) setPreviewId(items[0].id);
    else setBulkItems(items);
  };

  const researchMissing = async () => {
    const approved = await confirm({
      title: `${needsResearch.length} firma araştırılsın mı?`,
      message:
        'Eksik mail, ofis adresi, çalışan sayısı, telefon ve çalışma düzeni web’de aranır; firmanın sitesi, KVKK ve iletişim sayfaları, ilan siteleri ve LinkedIn’e bakılır. Toplu araştırmanın kendi günlük kotası vardır; kota dolarsa kalan firmalar ertesi gün kendiliğinden devam eder.',
      confirmLabel: 'Araştır',
    });
    if (!approved) return;
    const result = await run(() => homeApi.researchMissing(needsResearch.map((c) => c.id)), { refresh: false });
    if (!result) return;
    void batch.refetch();
    toast.info(result.queued > 0 ? `${result.queued} firma araştırma sırasına alındı; ilerlemeyi bu çubukta görebilirsin.` : 'Bu firmalar zaten araştırılıyor.');
  };

  const cancelResearch = () => run(() => homeApi.cancelResearchBatch(), { success: 'Sıradaki firmaların araştırması durduruldu', refresh: false }).then(() => batch.refetch());

  const findSizes = async () => {
    const approved = await confirm({
      title: 'Çalışan sayıları aransın mı?',
      message: `Çalışan sayısı bilinmeyen firmalar ${SIZE_SEARCH_GROUP}'lik gruplar halinde web'de aranır; her grup günlük AI hakkından 1 düşer. Başka bir kullanıcının öğrendiği sayılar aranmadan gelir.`,
      confirmLabel: 'Ara',
    });
    if (!approved) return;
    const result = await run(() => homeApi.researchSizes(), { refresh: false });
    if (!result) return;
    if (result.queued === 0) return toast.info('Aranacak firma kalmadı; bulunamayanlar bir süre sonra yeniden denenir.');
    toast.info(`${result.queued} firmanın çalışan sayısı aranıyor; sonuçlar birkaç dakika içinde kartlarda görünür.${result.remaining > 0 ? ` ${result.remaining} firma sonraki aramaya kaldı.` : ''}`);
  };

  const scan = async () => {
    const result = await run(() => homeApi.targetedSearch(query), { refresh: false });
    if (!result) return;
    setScanned((current) => new Set([...current, query]));
    toast.info(`"${query}" için ilan aranıyor. Bulunan ilanlar birkaç dakika içinde listeye eklenir; günlük AI hakkından 1 düşer.`);
  };

  const lookup = async () => {
    const result = await run(() => homeApi.lookupCompany(query), { refresh: false });
    if (!result) return;
    if (result.status === 'exists') {
      toast.info(`${result.name} zaten listende`);
      setFilters({ ...filters, query: result.name ?? query });
    } else if (result.lookupId) lookups.start(result.lookupId, query);
  };

  const actions: CompanyCardActions = {
    onToggleSelect: (id) => setSelected((current) => new Set(current.has(id) ? [...current].filter((x) => x !== id) : [...current, id])),
    onApply: (opportunity) => applyTo([opportunity]),
    onMarkApplied: (opportunity) => run(() => homeApi.markApplied(opportunity.id), { success: `${opportunity.company} Başvurularım'a taşındı` }),
    onDismiss: (opportunity) => run(() => homeApi.dismiss(opportunity.id), { success: 'Gizlendi' }),
    onResearch: (companyId) => run(() => homeApi.researchCompany(companyId).then(() => setResearch((current) => ({ ...current, [companyId]: now }))), { success: 'Firma bilgileri aranıyor', refresh: false }),
    onSetLanguage: (companyId, language) =>
      run(() => homeApi.setCompanyLanguage(companyId, language), { success: language ? `Bu firmaya ${language === 'en' ? 'İngilizce' : 'Türkçe'} yazılacak; hazır yazılar çevriliyor` : 'Yazı dili firmaya göre otomatik seçilecek' }),
    onMergeWith: (companyId) => setMergeId(companyId),
    onToggleAnalysis: (companyId) => setOpenAnalysis((current) => new Set(current.has(companyId) ? [...current].filter((x) => x !== companyId) : [...current, companyId])),
  };

  if (!data) return <LoadingBlock label="Firmalar yükleniyor…" />;

  const card = (company: HomeCompany) => (
    <CompanyCard
      key={company.id}
      company={company}
      showClass={filters.sort !== 'recommended'}
      selected={chosen}
      applying={applying}
      researching={isResearching(company)}
      analysisOpen={openAnalysis.has(company.id)}
      busy={busy}
      {...actions}
    />
  );

  const canLookup = query.length >= MIN_LOOKUP_LENGTH && !exactMatch;
  const canScan = query.length >= MIN_SCAN_LENGTH;
  const lookupRow = (canLookup || canScan || lookups.pending.length > 0) && (
    <div className="flex flex-col gap-2 text-sm">
      {(canLookup || canScan) && (
        <div className="flex flex-wrap items-center gap-2 text-ink-soft">
          Aradığın listede yok mu?
          {canLookup && (
            <Button variant="outline" size="sm" icon={<Plus className="size-4" aria-hidden />} disabled={busy || lookups.pending.includes(query)} onClick={lookup}>
              "{query}" kurumunu bul ve ekle
            </Button>
          )}
          {canScan && (
            <Button variant="outline" size="sm" icon={<Radar className="size-4" aria-hidden />} disabled={busy || scanned.has(query)} onClick={scan} title="Yazdığın metinle (unvan, şehir, sektör, teknoloji) ilan sitelerinde ve firma kariyer sayfalarında açık ilan aranır">
              {scanned.has(query) ? 'İlan taraması başladı' : `"${query}" için ilan tara`}
            </Button>
          )}
        </div>
      )}
      {lookups.pending.map((name) => (
        <InlineBusy key={name}>"{name}" aranıyor: site, kariyer sayfası, ilgili ilanlar ve iletişim bilgileri bulunuyor (1-2 dk).</InlineBusy>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {focused && (
        <Notice
          icon={<BellRing className="size-5 shrink-0" aria-hidden />}
          action={
            <Button variant="tonal" size="sm" onClick={clearFocus}>
              Tüm firmaları göster
            </Button>
          }
        >
          {focusedCount > 0
            ? `Bildirimdeki ${focusedCount} ilan gösteriliyor${focusedCount < focusSize ? `; ${focusSize - focusedCount} ilan artık listede değil (başvurulmuş, gizlenmiş ya da kapanmış olabilir)` : ''}.`
            : 'Bildirimdeki ilanlar artık listede değil: başvurulmuş, gizlenmiş ya da kapanmış olabilir.'}
        </Notice>
      )}
      {!focused && (twins.data?.length ?? 0) > 0 && (
        <Notice
          icon={<Combine className="size-5 shrink-0" aria-hidden />}
          action={
            <Button variant="tonal" size="sm" onClick={() => setTwinsOpen(true)}>
              İncele
            </Button>
          }
        >
          {twins.data!.length} çift kayıt aynı firma olabilir (ör. ilan sitelerinde farklı yazılmış ad). Kesin olanlar kendiliğinden birleşir; diğerlerine sen karar ver.
        </Notice>
      )}
      {twinsOpen && <TwinsDialog twins={twins.data ?? []} onClose={() => setTwinsOpen(false)} onChanged={afterMerge} />}
      {mergeId && companies.find((c) => c.id === mergeId) && <MergeWithDialog company={companies.find((c) => c.id === mergeId)!} companies={companies} onClose={() => setMergeId(null)} onChanged={afterMerge} />}
      {data.totals.truncated && (
        <Notice tone="warn">Fırsat sayısı liste sınırını aştı; en düşük sıradaki bazı fırsatlar gösterilmiyor. Filtrelerle daralttığında da yalnızca listedekiler arasında aranır.</Notice>
      )}
      {!focused && englishWithoutCv > 0 && (
        <Notice
          tone="warn"
          icon={<Languages className="size-5 shrink-0" aria-hidden />}
          action={
            <Link to="/profile" className="text-sm font-medium text-brand hover:underline">
              İngilizce CV yükle
            </Link>
          }
        >
          {englishWithoutCv} firmaya İngilizce başvuru yazılıyor ama İngilizce CV'n yok. Bu başvurular otomatik gönderilmez; kontrol edip kendin gönderebilirsin.
        </Notice>
      )}
      {!focused && (
        <>
          <CompanyToolbar filters={filters} onChange={setFilters} totals={data.totals} regionLabels={data.regionFilters ?? []} regions={regions} workModes={workModes} sizes={sizes} scopes={scopes} shown={filtered.length} busy={busy} onFindSizes={findSizes} />
          <JobSiteSearch />
          {lookupRow}
        </>
      )}
      {(selectable.length > 0 || needsResearch.length > 0 || !!batch.data) && (
        <div className="sticky top-14 z-30 -mx-1 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface/95 px-3 py-2 shadow-sm backdrop-blur">
          {selectable.length > 0 && <Checkbox checked={allChosen} onChange={() => setSelected(allChosen ? new Set() : selectableIds)} label={allChosen ? 'Seçimi kaldır' : `Mail adresi olanların tümünü seç (${selectable.length})`} />}
          {batch.data && (batchRunning || needsResearch.length === 0) ? (
            <ResearchProgress batch={batch.data} busy={busy} onCancel={cancelResearch} />
          ) : (
            needsResearch.length > 0 && (
              <span className="flex flex-wrap items-center gap-x-2 text-sm text-ink-soft">
                {[missingEmail.length > 0 && `${missingEmail.length} fırsatın maili yok`, missingOffice > 0 && `${missingOffice} firmanın adresi yok`, missingSize > 0 && `${missingSize} firmanın çalışan sayısı yok`].filter(Boolean).join(' · ')}
                <Button variant="ghost" size="sm" disabled={busy} icon={<Search className="size-4" aria-hidden />} onClick={researchMissing}>
                  Eksik bilgileri araştır ({needsResearch.length} firma)
                </Button>
                {batch.data && <span className="text-xs">Son araştırma: {foundSummary(batch.data)}</span>}
              </span>
            )
          )}
          {chosen.size > 0 && (
            <Button variant="primary" size="sm" className="ml-auto" disabled={busy} icon={<Send className="size-4" aria-hidden />} onClick={() => applyTo(selectable.filter((o) => chosen.has(o.id)))}>
              Seçilenlere başvur ({chosen.size})
            </Button>
          )}
        </div>
      )}
      {filtered.length === 0 ? (
        !focused && (
        <Panel>
          <EmptyState icon={<Building2 aria-hidden />}>
            {companies.length === 0
              ? state.activity.status === 'working'
                ? 'Firmalar ve ilanlar aranıyor. İlk sonuçlar birkaç dakika içinde burada görünecek.'
                : 'Henüz sonuç yok. Uygulama her gün kendisi tarar; istersen yukarıdan "Yeniden ara" ile hemen başlatabilirsin.'
              : activeFilterCount(filters) > 0
                ? 'Bu arama ve filtrelerle eşleşen firma yok.'
                : 'Başvurmadığın firma kalmadı.'}
          </EmptyState>
        </Panel>
        )
      ) : filters.sort === 'recommended' ? (
        groupByClass(shown).map((group) => (
          <section key={group.companyClass} className="flex flex-col gap-2.5" aria-label={CLASS_INFO[group.companyClass].title}>
            <header className="px-1">
              <h2 className="text-sm font-semibold">
                {CLASS_INFO[group.companyClass].title} <span className="font-normal text-ink-soft">({filtered.filter((c) => c.class === group.companyClass).length})</span>
              </h2>
              <p className="text-xs text-ink-soft">{CLASS_INFO[group.companyClass].hint}</p>
            </header>
            {group.companies.map(card)}
          </section>
        ))
      ) : (
        <div className="flex flex-col gap-2.5">{shown.map(card)}</div>
      )}
      <div ref={sentinel} aria-hidden />
      {filtered.length > shown.length && (
        <Button variant="outline" className="self-center" onClick={showMore}>
          Daha fazla göster ({filtered.length - shown.length} firma kaldı)
        </Button>
      )}
      {previewId && <ApplyPreviewDialog opportunityId={previewId} onClose={(sent) => closeDialog(sent, [previewId])} />}
      {bulkItems && <BulkReviewDialog items={bulkItems} onClose={(sent) => closeDialog(sent, [])} />}
    </div>
  );
}
