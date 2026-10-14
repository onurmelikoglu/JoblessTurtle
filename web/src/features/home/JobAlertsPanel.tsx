import { BellRing, CircleCheck, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import type { HomeInbox } from '@/api/types';
import { fmtAgo } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { LinkButton } from '@/ui/Button';
import { FilterChip } from '@/ui/controls';
import { Panel, PanelTitle } from '@/ui/Panel';
import { ALERT_SITES, alertSiteState, chosenTitles, toggled } from './alert-sites';

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
  const { titles, cities } = inbox.alerts;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(titles.slice(0, 1)));
  const [pickedCity, setCity] = useState<string | null>(cities[0] ?? null);
  const chosen = chosenTitles(titles, selected);
  const city = pickedCity && cities.includes(pickedCity) ? pickedCity : null;

  if (titles.length === 0) return <p className="text-sm text-ink-soft">Arama profiline pozisyon eklenince buradan alarm kurabilirsin.</p>;
  const query = { titles: chosen, city };
  const singleOnly = ALERT_SITES.filter((site) => !site.supportsOr);
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
      <div className="flex flex-col gap-1.5">
        <span className="font-medium">Şehir</span>
        <div className="flex flex-wrap gap-2">
          {[...cities, null].map((option) => (
            <FilterChip key={option ?? NATIONWIDE} active={city === option} onToggle={() => setCity(option)}>
              {option ?? NATIONWIDE}
            </FilterChip>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {ALERT_SITES.map((site) => (
          <LinkButton key={site.platform} href={site.searchUrl(query)} variant="outline" size="sm" icon={<ExternalLink className="size-4" aria-hidden />}>
            {site.openLabel}
          </LinkButton>
        ))}
      </div>
      {chosen.length > 1 &&
        singleOnly.map((site) => (
          <p key={site.platform} className="text-xs text-ink-soft">
            {site.platform} tek pozisyonla arar; "{chosen[0]}" ile açılır{city ? ', şehri sayfadan seç' : ''}.
          </p>
        ))}
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
          <li>Pozisyonları ve şehri seç, bir sitenin butonuna bas; site bu aramayla yeni sekmede açılır.</li>
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
