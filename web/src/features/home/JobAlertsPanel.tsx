import { BellRing, CircleCheck, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import type { HomeInbox } from '@/api/types';
import { CITY_OPTIONS } from '@/features/shared/cities';
import { fmtAgo } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { LinkButton } from '@/ui/Button';
import { FilterChip } from '@/ui/controls';
import { Panel, PanelTitle } from '@/ui/Panel';
import { TagsInput } from '@/ui/TagsInput';
import { ALERT_SITES, alertSiteState, chosenTitles, isPartOfCity, toggled } from './alert-sites';

const NATIONWIDE = 'Türkiye geneli';

function SiteStatus({ inbox }: { inbox: HomeInbox }) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Sitelerdeki alarmlar">
      {ALERT_SITES.map((site) => {
        const state = alertSiteState(site.platform, inbox.alerts.sites);
        return (
          <li key={site.platform}>
            {state.kind === 'working' ? (
              <Badge tone="good" icon={<CircleCheck className="size-3.5" aria-hidden />}>
                {site.platform} · çalışıyor{state.lastAt ? `, son mail ${fmtAgo(state.lastAt)}` : ''}
              </Badge>
            ) : (
              <Badge>{site.platform} · kurulmadı</Badge>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function AlertSetup({ inbox }: { inbox: HomeInbox }) {
  const { titles } = inbox.alerts;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(titles.slice(0, 1)));
  const [cities, setCities] = useState<string[]>(() => inbox.alerts.cities.filter((city) => (CITY_OPTIONS as readonly string[]).includes(city)));
  const chosen = chosenTitles(titles, selected);

  if (titles.length === 0) return <p className="text-sm text-ink-soft">Arama profiline pozisyon eklenince buradan alarm kurabilirsin.</p>;
  const perCity = ALERT_SITES.filter((site) => site.perCity);
  const single = ALERT_SITES.filter((site) => !site.perCity);
  const rows: (string | null)[] = cities.length ? cities : [null];
  const anyPart = cities.some(isPartOfCity);
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-1.5">
        <span className="font-medium">Pozisyonlar</span>
        <div className="flex flex-wrap gap-2">
          {titles.map((title) => (
            <FilterChip key={title} active={chosen.includes(title)} onToggle={() => setSelected(toggled(new Set(chosen), title))}>
              {title}
            </FilterChip>
          ))}
        </div>
        <span className="text-xs text-ink-soft">Birden fazla seçersen (ör. Türkçe ve İngilizce adı) LinkedIn ve Indeed hepsini tek alarmda birleştirir.</span>
      </div>
      <TagsInput label="Şehirler" values={cities} onChange={setCities} options={CITY_OPTIONS} placeholder="Şehir ekle (yazarak ara)" hint="Her şehir için ayrı alarm kurulur; boş bırakırsan Türkiye geneli aranır. İstanbul'u Anadolu ya da Avrupa yakası olarak da seçebilirsin." />
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line" aria-label="Kurulacak alarmlar">
        {rows.map((city) => (
          <li key={city ?? NATIONWIDE} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="min-w-36 flex-1 font-medium">{city ?? NATIONWIDE}</span>
            {perCity.map((site) => (
              <LinkButton key={site.platform} href={site.searchUrl({ titles: chosen, city })} variant="outline" size="sm" icon={<ExternalLink className="size-4" aria-hidden />}>
                {site.openLabel}
              </LinkButton>
            ))}
          </li>
        ))}
        {single.map((site) => (
          <li key={site.platform} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="min-w-36 flex-1 text-ink-soft">
              {site.platform}: şehri sayfadaki filtreden seç{chosen.length > 1 ? `; "${chosen[0]}" ile açılır` : ''}
            </span>
            <LinkButton href={site.searchUrl({ titles: chosen, city: null })} variant="outline" size="sm" icon={<ExternalLink className="size-4" aria-hidden />}>
              {site.openLabel}
            </LinkButton>
          </li>
        ))}
      </ul>
      {anyPart && <p className="text-xs text-ink-soft">LinkedIn ve Indeed İstanbul'un yakalarını ayırmaz; bu sitelerde İstanbul geneli aranır. Kariyer.net'te yakayı sayfadaki şehir filtresinden seçebilirsin.</p>}
    </div>
  );
}

/** İş sitelerinin alarm maillerinden eklenen ilanlar, sitelerdeki alarm durumu ve seçimle alarm kurulumu. */
export function JobAlertsPanel({ inbox }: { inbox: HomeInbox }) {
  const { alerts } = inbox;
  const reading = inbox.accounts.filter((a) => a.supported && a.enabled);
  const address = reading.map((a) => a.email).join(', ');
  const allWorking = ALERT_SITES.every((site) => alertSiteState(site.platform, alerts.sites).kind === 'working');
  return (
    <Panel className="flex flex-col gap-3">
      <PanelTitle icon={<BellRing className="size-5 text-ink-soft" aria-hidden />}>İş alarmları</PanelTitle>
      <p className="text-sm text-ink-soft">
        Kariyer.net, LinkedIn ve Indeed gibi siteler ilanlarının dışarıdan taranmasına izin vermiyor. Bu sitelerde bir iş alarmı kurarsan sitenin sana gönderdiği ilan maillerini okur, arama profiline uyan ilanları Firmalar listene ekler.
      </p>
      {reading.length === 0 && <p className="text-sm text-warn">İş alarmlarının okunması için yukarıdaki gelen kutusu takibi açık olmalı.</p>}
      <SiteStatus inbox={inbox} />
      {alerts.mails > 0 && (
        <p className="text-sm text-ink-soft">
          {alerts.mails} alarm mailinden {alerts.listings} ilan eklendi{alerts.lastAt ? ` · son mail ${fmtAgo(alerts.lastAt)}` : ''}
        </p>
      )}
      {allWorking ? (
        <details className="text-sm">
          <summary className="cursor-pointer rounded font-medium text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Yeni alarm kur</summary>
          <div className="mt-3">
            <AlertSetup inbox={inbox} />
          </div>
        </details>
      ) : (
        <section className="flex flex-col gap-3 rounded-lg border border-line p-3 sm:p-4" aria-label="Alarm kur">
          <h3 className="text-sm font-semibold">Alarm kur</h3>
          <AlertSetup inbox={inbox} />
        </section>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer rounded font-medium text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Alarm nasıl kurulur?</summary>
        <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-ink-soft">
          <li>Pozisyonları ve şehirleri seç, her şehir için sitenin butonuna bas; site bu aramayla yeni sekmede açılır.</li>
          <li>
            Sitede hesabınla giriş yapıp sonuçların üstündeki alarm düğmesine bas ({ALERT_SITES.map((s) => `${s.platform}: "${s.action}"`).join(', ')}); sıklık olarak "günlük"ü seç.
          </li>
          <li>
            Alarm maillerinin {address ? <span className="font-medium text-ink">{address}</span> : 'bağlı mail'} adresine gelmesi gerekir. Sitedeki hesabın başka bir adresle açıksa o adresten bu adrese otomatik yönlendirme kur.
          </li>
          <li>İlk alarm maili geldiğinde site "çalışıyor" olarak işaretlenir; profiline uyan ilanlar listeye eklenir.</li>
        </ol>
      </details>
    </Panel>
  );
}
