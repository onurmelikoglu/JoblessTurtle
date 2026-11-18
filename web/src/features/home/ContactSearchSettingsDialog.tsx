import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ListChecks, Sparkles, Zap } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { homeApi } from '@/api/home';
import { useAction } from '@/api/queries';
import type { ContactSearchSettingsView, ContactSearchView } from '@/api/types';
import { Button } from '@/ui/Button';
import { FilterChip } from '@/ui/controls';
import { Dialog } from '@/ui/Dialog';
import { LoadError, LoadingBlock } from '@/ui/feedback';
import { Field, Input, Switch } from '@/ui/fields';
import { planDescription, RETRY_PLAN_LABEL, RETRY_PLAN_ORDER, summaryLine } from './contact-search-model';

const CONTACT_SEARCH_QUERY = ['home', 'contact-search'] as const;

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function SettingsForm({ view, onClose }: { view: ContactSearchView; onClose: () => void }) {
  const [form, setForm] = useState<ContactSearchSettingsView>(view.settings);
  const { busy, run } = useAction();
  const client = useQueryClient();
  const patch = (next: Partial<ContactSearchSettingsView>) => setForm((current) => ({ ...current, ...next }));
  const limitValid = Number.isInteger(form.opusDailyLimit) && form.opusDailyLimit >= 1 && form.opusDailyLimit <= view.maxOpusDailyLimit;

  const save = async () => {
    const saved = await run(() => homeApi.saveContactSearchSettings(form), { success: 'Adres araması ayarları kaydedildi' });
    if (!saved) return;
    client.setQueryData(CONTACT_SEARCH_QUERY, saved);
    onClose();
  };

  return (
    <Dialog
      open
      size="md"
      onClose={onClose}
      locked={busy}
      title="Adres araması ayarları"
      description="Mail adresi bulunamayan firmaların ne zaman ve hangi modelle yeniden aranacağı."
      footer={
        <>
          {!limitValid && <p className="mr-auto text-sm text-bad">Opus günlük sınırı 1–{view.maxOpusDailyLimit} arasında olmalı</p>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Vazgeç
          </Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={!limitValid}>
            Kaydet
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Section icon={<ListChecks className="size-4" aria-hidden />} title="Şu anki durum">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink-soft">
            {summaryLine(view.summary, form).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Section>

        <Section icon={<CalendarClock className="size-4" aria-hidden />} title="Bulunamayanları ne zaman yeniden ara">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Yeniden arama takvimi">
            {RETRY_PLAN_ORDER.map((plan) => (
              <FilterChip key={plan} active={form.retryPlan === plan} onToggle={() => patch({ retryPlan: plan })}>
                {RETRY_PLAN_LABEL[plan]} · {view.plans[plan].join(' → ')} gün
              </FilterChip>
            ))}
          </div>
          <p className="text-xs text-ink-soft">{planDescription(view.plans[form.retryPlan])} Adres yayımlamayan firma böylece zamanla kota harcamayı bırakır.</p>
        </Section>

        <Section icon={<Sparkles className="size-4" aria-hidden />} title="Opus ile tekrar">
          <Switch
            label="Sonnet bulamazsa Opus ile ara"
            description="Opus daha dikkatli arar ama Claude kotasını daha hızlı tüketir. Sonnet adres bulamazsa Opus hemen bir kez dener; daha önce hiç Opus ile aranmamış firmalar da her sabah 10:00'da sırayla aranır. “Eksik bilgileri araştır” ya da “Mail adresini ara” dediğinde firma bekleme süresine bakılmadan hemen aranır ve bu Opus denemesi günlük sınıra takılmaz."
            checked={form.opusRetry}
            onChange={(opusRetry) => patch({ opusRetry })}
          />
          <Field label="Opus ile günde en çok kaç firma" hint="Arama içindeki tekrarlar ve sabah taraması birlikte sayılır.">
            {(props) => (
              <Input {...props} type="number" className="max-w-32" min={1} max={view.maxOpusDailyLimit} disabled={!form.opusRetry} value={form.opusDailyLimit} onChange={(e) => patch({ opusDailyLimit: Number(e.target.value) })} />
            )}
          </Field>
        </Section>

        <Section icon={<Zap className="size-4" aria-hidden />} title="Yeni bilgi gelince">
          <Switch
            label="Beklemeden yeniden ara"
            description="Firmanın yeni ilanı çıkınca ya da web sitesi öğrenilince bekleme süresi dolmadan yeniden aranır. Aynı firma iki günden sık aranmaz."
            checked={form.retryOnNewInfo}
            onChange={(retryOnNewInfo) => patch({ retryOnNewInfo })}
          />
        </Section>
      </div>
    </Dialog>
  );
}

export function ContactSearchSettingsDialog({ onClose }: { onClose: () => void }) {
  const query = useQuery({ queryKey: CONTACT_SEARCH_QUERY, queryFn: homeApi.contactSearchSettings });
  if (query.data) return <SettingsForm view={query.data} onClose={onClose} />;
  return (
    <Dialog open size="sm" onClose={onClose} title="Adres araması ayarları">
      {query.isError ? <LoadError label="Ayarlar" onRetry={() => void query.refetch()} /> : <LoadingBlock label="Ayarlar yükleniyor…" />}
    </Dialog>
  );
}
