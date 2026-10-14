import { BellRing, CircleCheck, ExternalLink } from 'lucide-react';
import type { HomeInbox } from '@/api/types';
import { fmtAgo } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { LinkButton } from '@/ui/Button';
import { Panel, PanelTitle } from '@/ui/Panel';
import { ALERT_SITES, alertSiteState, searchLabel } from './alert-sites';

/** İş sitelerinin gönderdiği alarm maillerinden eklenen ilanlar ve profildeki aramalar için site site alarm kurulumu. */
export function JobAlertsPanel({ inbox }: { inbox: HomeInbox }) {
  const { alerts } = inbox;
  const reading = inbox.accounts.filter((a) => a.supported && a.enabled);
  const address = reading.map((a) => a.email).join(', ');
  return (
    <Panel className="flex flex-col gap-3">
      <PanelTitle icon={<BellRing className="size-5 text-ink-soft" aria-hidden />}>İş alarmları</PanelTitle>
      <p className="text-sm text-ink-soft">
        Kariyer.net, LinkedIn ve Indeed gibi siteler ilanlarının dışarıdan taranmasına izin vermiyor. Bu sitelerde bir iş alarmı kurarsan sitenin sana gönderdiği ilan maillerini okur, arama profiline uyan ilanları Firmalar listene ekler.
      </p>
      {reading.length === 0 ? (
        <p className="text-sm text-warn">İş alarmlarının okunması için yukarıdaki gelen kutusu takibi açık olmalı.</p>
      ) : (
        alerts.mails > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="good">{alerts.listings} ilan eklendi</Badge>
            <span className="text-ink-soft">
              {alerts.mails} alarm maili okundu{alerts.lastAt ? ` · son mail ${fmtAgo(alerts.lastAt)}` : ''}
            </span>
          </div>
        )
      )}
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {ALERT_SITES.map((site) => {
          const state = alertSiteState(site.platform, alerts.sites);
          return (
            <li key={site.platform} className="flex flex-col gap-2 px-3 py-3 text-sm sm:px-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{site.platform}</h3>
                {state.kind === 'working' ? (
                  <Badge tone="good" icon={<CircleCheck className="size-3.5" aria-hidden />}>
                    Alarm çalışıyor · {state.mails} mail{state.lastAt ? `, son ${fmtAgo(state.lastAt)}` : ''}
                  </Badge>
                ) : (
                  <span className="text-ink-soft">Henüz alarm maili gelmedi</span>
                )}
              </div>
              {alerts.searches.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {alerts.searches.map((search) => (
                    <LinkButton key={searchLabel(search)} href={site.searchUrl(search)} variant="outline" size="sm" icon={<ExternalLink className="size-4" aria-hidden />}>
                      {searchLabel(search)}
                    </LinkButton>
                  ))}
                </div>
              ) : (
                <p className="text-ink-soft">Arama profiline unvan eklenince burada hazır aramalar çıkar.</p>
              )}
            </li>
          );
        })}
      </ul>
      <details className="text-sm">
        <summary className="cursor-pointer rounded font-medium text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Alarm nasıl kurulur?</summary>
        <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-ink-soft">
          <li>Yukarıdan bir aramaya bas; site o unvanla (LinkedIn ve Indeed'de şehirle birlikte) açılır. Kariyer.net'te şehri sayfadan seç.</li>
          <li>
            Sitede hesabınla giriş yapıp sonuçların üstündeki alarm düğmesine bas ({ALERT_SITES.map((s) => `${s.platform}: "${s.action}"`).join(', ')}); sıklık olarak "günlük"ü seç.
          </li>
          <li>
            Alarm maillerinin {address ? <span className="font-medium text-ink">{address}</span> : 'bağlı mail'} adresine gelmesi gerekir. Sitedeki hesabın başka bir adresle açıksa o adresten bu adrese otomatik yönlendirme kur.
          </li>
          <li>İlk alarm maili geldiğinde sitenin yanında "Alarm çalışıyor" yazar; profiline uyan ilanlar listeye eklenir.</li>
        </ol>
      </details>
    </Panel>
  );
}
