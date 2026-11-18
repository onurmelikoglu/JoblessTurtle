import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Briefcase, FileCheck2, Gauge, ListChecks, MapPin, Plus, Search, Users, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { homeApi } from '@/api/home';
import { useAction } from '@/api/queries';
import type { AutoApplyExplain, AutoApplyView } from '@/api/types';
import { Button } from '@/ui/Button';
import { FilterChip } from '@/ui/controls';
import { Dialog } from '@/ui/Dialog';
import { LoadError, LoadingBlock } from '@/ui/feedback';
import { Checkbox, Field, Input, Select, Switch } from '@/ui/fields';
import { Notice } from '@/ui/Notice';
import { AUTO_WORK_MODES, CV_LAYOUT_TEXT, dailySearches, formOf, formProblems, intervalLabel, MAX_PAGES_TEXT, RANGE_TEXT, REWRITE_MODE_TEXT, toggled, WORK_MODE_TEXT, type AutoApplyForm } from './auto-apply-model';

const AUTO_APPLY_QUERY = ['home', 'auto-apply'] as const;
const SHOWN_REASONS = 6;

function Section({ icon, title, children, plain = false }: { icon: ReactNode; title: string; children: ReactNode; plain?: boolean }) {
  return (
    <section className={plain ? 'flex flex-col gap-3' : 'flex flex-col gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0'}>
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function Explain({ explain }: { explain: AutoApplyExplain }) {
  const { passes } = explain;
  const blocked = passes.open > 0 && passes.all === 0;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink-soft">
        {explain.rules.map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>
      <p className="text-sm">
        Açık hedef ilan <strong>{passes.open}</strong> · uyum eşiğini geçen <strong>{passes.f}</strong> · kalite eşiğini geçen <strong>{passes.q}</strong> · kapsam eşiğini geçen{' '}
        <strong>{passes.coverage}</strong> · hepsini geçen <strong>{passes.all}</strong>
        <span className="text-ink-soft"> · bugün gönderilen {explain.sentToday}, sırada {explain.queued}</span>
      </p>
      {blocked && (
        <Notice tone="warn">Bu eşiklerle şu an hiçbir ilan otomatik başvuruya uygun değil. Aşağıdaki "Eşikler" bölümünden firma kalitesi ya da kapsam eşiğini düşürebilir veya kapatabilirsin.</Notice>
      )}
      {explain.reasons.length > 0 && (
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-ink-soft">Son 7 günde başvurmama nedenleri ({explain.evaluated} ilan değerlendirildi)</p>
          <ul className="flex flex-col gap-1 text-sm">
            {explain.reasons.slice(0, SHOWN_REASONS).map((reason) => (
              <li key={reason.code} className="flex justify-between gap-3">
                <span>{reason.label}</span>
                <span className="text-ink-soft tabular-nums">{reason.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SettingsForm({ view, onClose }: { view: AutoApplyView; onClose: () => void }) {
  const [form, setForm] = useState<AutoApplyForm>(() => formOf(view.settings!));
  const [province, setProvince] = useState('');
  const { busy, run } = useAction();
  const client = useQueryClient();
  const patch = (next: Partial<AutoApplyForm>) => setForm((current) => ({ ...current, ...next }));
  const problems = formProblems(form);
  const { options } = view;
  const cityChoices = [...new Set([...options.profileCities, ...form.filterCities])];
  const addProvince = () => {
    if (province && !form.filterCities.includes(province)) patch({ filterCities: [...form.filterCities, province] });
    setProvince('');
  };

  const save = async () => {
    const saved = await run(() => homeApi.saveAutoApplySettings(form), { success: 'Otomatik başvuru ayarları kaydedildi; ilanlar yeni ayarlarla yeniden değerlendiriliyor' });
    if (!saved) return;
    client.setQueryData(AUTO_APPLY_QUERY, saved);
    onClose();
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      locked={busy}
      title="Otomatik başvuru ayarları"
      description={view.settings!.autoSend ? 'Otomatik başvuru açık: uygun ilanlara mesai saatlerinde kendisi başvurur.' : 'Otomatik başvuru kapalı: yazılar hazırlanır, gönderimi sen onaylarsın. Ayarlar açıldığında geçerli olur.'}
      footer={
        <>
          {problems.length > 0 && <p className="mr-auto text-sm text-bad">{problems[0]}</p>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Vazgeç
          </Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={problems.length > 0}>
            Kaydet
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {view.explain && (
          <Section icon={<ListChecks className="size-4" aria-hidden />} title="Şu an neye göre başvuruyor">
            <Explain explain={view.explain} />
          </Section>
        )}

        <Section icon={<Search className="size-4" aria-hidden />} title="Ne sıklıkla, ne kadar">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Günde en çok başvuru" hint="Sınır dolarsa kalan ilanlar ertesi sabah sıraya girer.">
              {(props) => <Input {...props} type="number" min={1} max={100} value={form.dailyLimit} onChange={(e) => patch({ dailyLimit: Number(e.target.value) })} />}
            </Field>
            <Field
              label="Yeniden ilan arama sıklığı"
              hint={`Günde yaklaşık ${dailySearches(form.searchEveryHours)} yapay zekâ araması (her biri günlük AI hakkından 1).${options.canSetScraperInterval ? ' Yönetici olduğun için ilan sitesi taraması da bu aralığa eşlenir (tüm kullanıcılar için).' : ''}`}
            >
              {(props) => (
                <Select {...props} value={form.searchEveryHours} onChange={(e) => patch({ searchEveryHours: Number(e.target.value) })}>
                  {options.searchIntervals.map((hours) => (
                    <option key={hours} value={hours}>
                      {intervalLabel(hours)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="İyileştirilmiş CV en fazla" hint={MAX_PAGES_TEXT[form.atsMaxPages].hint} className="sm:col-span-2">
              {(props) => (
                <Select {...props} value={form.atsMaxPages} onChange={(e) => patch({ atsMaxPages: Number(e.target.value) as AutoApplyForm['atsMaxPages'] })}>
                  {(Object.keys(MAX_PAGES_TEXT).map(Number) as AutoApplyForm['atsMaxPages'][]).map((pages) => (
                    <option key={pages} value={pages}>
                      {MAX_PAGES_TEXT[pages].label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="İyileştirilmiş CV görünümü" hint={CV_LAYOUT_TEXT[form.atsCvLayout].hint} className="sm:col-span-2">
              {(props) => (
                <Select {...props} value={form.atsCvLayout} onChange={(e) => patch({ atsCvLayout: e.target.value as AutoApplyForm['atsCvLayout'] })}>
                  {(Object.keys(CV_LAYOUT_TEXT) as AutoApplyForm['atsCvLayout'][]).map((layout) => (
                    <option key={layout} value={layout}>
                      {CV_LAYOUT_TEXT[layout].label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </Section>

        <Section icon={<MapPin className="size-4" aria-hidden />} title="Şehir">
          <p className="text-xs text-ink-soft">Hiçbiri seçili değilse profildeki bölgelerin geçerlidir. Seçersen yalnızca bu şehirlerdeki ilanlara başvurulur; uzaktan ilanlar her zaman dahildir.</p>
          <div className="flex flex-wrap gap-1.5">
            {cityChoices.map((city) => (
              <FilterChip key={city} active={form.filterCities.includes(city)} onToggle={() => patch({ filterCities: toggled(form.filterCities, city) })}>
                {city}
              </FilterChip>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-48 flex-1 sm:max-w-xs">
              <Select aria-label="Başka il ekle" value={province} onChange={(e) => setProvince(e.target.value)}>
                <option value="">Başka il ekle…</option>
                {options.provinces
                  .filter((p) => !cityChoices.includes(p))
                  .map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
              </Select>
            </div>
            <Button variant="outline" size="sm" icon={<Plus className="size-4" aria-hidden />} disabled={!province} onClick={addProvince}>
              Ekle
            </Button>
            {form.filterCities.length > 0 && (
              <Button variant="ghost" size="sm" icon={<X className="size-4" aria-hidden />} onClick={() => patch({ filterCities: [] })}>
                Profildeki bölgelere dön
              </Button>
            )}
          </div>
        </Section>

        <div className="grid gap-5 border-t border-line pt-4 sm:grid-cols-2">
          <Section plain icon={<Briefcase className="size-4" aria-hidden />} title="Çalışma şekli">
            <div className="flex flex-wrap gap-1.5">
              {AUTO_WORK_MODES.map((mode) => (
                <FilterChip key={mode} active={form.filterWorkModes.includes(mode)} onToggle={() => patch({ filterWorkModes: toggled(form.filterWorkModes, mode) })}>
                  {WORK_MODE_TEXT[mode]}
                </FilterChip>
              ))}
            </div>
            <Checkbox checked={form.includeUnknownWorkMode} disabled={!form.filterWorkModes.length} onChange={(includeUnknownWorkMode) => patch({ includeUnknownWorkMode })} label="İlanda yazmıyorsa da başvur" />
          </Section>
          <Section plain icon={<Users className="size-4" aria-hidden />} title="Çalışan sayısı">
            <div className="flex flex-wrap gap-1.5">
              {options.employeeRanges.map((range) => (
                <FilterChip key={range} active={form.filterSizes.includes(range)} onToggle={() => patch({ filterSizes: toggled(form.filterSizes, range) })}>
                  {RANGE_TEXT[range]}
                </FilterChip>
              ))}
            </div>
            <Checkbox checked={form.includeUnknownSize} disabled={!form.filterSizes.length} onChange={(includeUnknownSize) => patch({ includeUnknownSize })} label="Çalışan sayısı bilinmiyorsa da başvur" />
          </Section>
        </div>

        <Section icon={<FileCheck2 className="size-4" aria-hidden />} title="CV ve ATS uyumu">
          <Switch
            label="Düşük ATS oranında CV'yi ilana göre iyileştir"
            description="Gönderimden önce CV ilanın gereksinimlerine göre puanlanır; eşiğin altındaysa yapay zekâ ilana uygun bir ATS sürümü hazırlar."
            checked={form.atsAutoImprove}
            onChange={(atsAutoImprove) => patch({ atsAutoImprove })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Düşük sayılan ATS oranı (%)">
              {(props) => <Input {...props} type="number" min={40} max={95} value={form.atsThreshold} onChange={(e) => patch({ atsThreshold: Number(e.target.value) })} />}
            </Field>
            <Field label="İyileştirme biçimi" hint={REWRITE_MODE_TEXT[form.atsRewriteMode].hint}>
              {(props) => (
                <Select {...props} value={form.atsRewriteMode} onChange={(e) => patch({ atsRewriteMode: e.target.value as AutoApplyForm['atsRewriteMode'] })}>
                  {(Object.keys(REWRITE_MODE_TEXT) as AutoApplyForm['atsRewriteMode'][]).map((mode) => (
                    <option key={mode} value={mode}>
                      {REWRITE_MODE_TEXT[mode].label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </Section>

        <details className="group border-t border-line pt-4">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold">
            <Gauge className="size-4" aria-hidden />
            Eşikler (gelişmiş)
          </summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Rol uyumu (F) en az" hint="Unvan, görev, konum ve koşullardan 0-100.">
              {(props) => <Input {...props} type="number" min={0} max={100} value={form.fMin} onChange={(e) => patch({ fMin: Number(e.target.value) })} />}
            </Field>
            <Field label="Firma kalitesi (Q) en az" hint="0 yazarsan aranmaz. Bilinmeyen firma bilgisi puana katkı vermez.">
              {(props) => <Input {...props} type="number" min={0} max={100} value={form.qMin} onChange={(e) => patch({ qMin: Number(e.target.value) })} />}
            </Field>
            <Field label="Firma bilgisi kapsamı en az (%)" hint="Firma hakkında bilinenlerin oranı; 0 yazarsan aranmaz.">
              {(props) => <Input {...props} type="number" min={0} max={100} value={Math.round(form.coverageMin * 100)} onChange={(e) => patch({ coverageMin: Number(e.target.value) / 100 })} />}
            </Field>
            <Field label="Aynı firmaya en erken (gün)">
              {(props) => <Input {...props} type="number" min={0} max={180} value={form.companyCooldownDays} onChange={(e) => patch({ companyCooldownDays: Number(e.target.value) })} />}
            </Field>
          </div>
        </details>
      </div>
    </Dialog>
  );
}

export function AutoApplySettingsDialog({ onClose }: { onClose: () => void }) {
  const query = useQuery({ queryKey: AUTO_APPLY_QUERY, queryFn: homeApi.autoApplySettings });
  if (query.data?.settings) return <SettingsForm view={query.data} onClose={onClose} />;
  return (
    <Dialog open size="sm" onClose={onClose} title="Otomatik başvuru ayarları">
      {query.isError ? <LoadError label="Ayarlar" onRetry={() => void query.refetch()} /> : query.data ? <Notice tone="warn">{query.data.blocker}</Notice> : <LoadingBlock label="Ayarlar yükleniyor…" />}
    </Dialog>
  );
}
