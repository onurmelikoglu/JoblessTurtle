import { useQuery } from '@tanstack/react-query';
import { CircleAlert, Play } from 'lucide-react';
import { adminApi } from '@/api/admin';
import { useAction } from '@/api/queries';
import type { ScraperConfig, ScraperRunView, ScraperSource, ScraperSourceStatus } from '@/api/types';
import { useMe } from '@/auth/session-context';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtDateTime, fmtUntil } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Switch } from '@/ui/fields';
import { Notice } from '@/ui/Notice';
import { TagsInput } from '@/ui/TagsInput';
import { TONE_TEXT } from '@/ui/tones';
import { adminKeys, useAdminRefresh } from './admin-queries';
import { Divider, LimitField, Loaded, Section, SubSection } from './parts';
import { ACTIVE_POLL_MS, errorKinds, EXTENSION_ONLY_NOTE, healthOf, IDLE_POLL_MS, INTERVAL_OPTIONS, isActive, keywordNote, PAGE_OPTIONS, runSourceLabel, runSummary, stateLabel, stateTone } from './scrapers-model';

const RUN_HEADINGS = ['Zaman', 'Site', 'Durum', 'Sonuç', 'Hata'];

function useScrapers() {
  const { user } = useMe();
  const status = useQuery({
    queryKey: [...adminKeys.scrapers, 'status'],
    queryFn: adminApi.scraperStatus,
    enabled: user.isAdmin,
    refetchInterval: (query) => (isActive(query.state.data?.sources) ? ACTIVE_POLL_MS : IDLE_POLL_MS),
  });
  const active = isActive(status.data?.sources);
  const history = useQuery({ queryKey: [...adminKeys.scrapers, 'history'], queryFn: () => adminApi.scraperHistory(10), enabled: user.isAdmin, refetchInterval: active ? ACTIVE_POLL_MS : IDLE_POLL_MS });
  const config = useQuery({ queryKey: [...adminKeys.scrapers, 'config'], queryFn: adminApi.scraperConfig, enabled: user.isAdmin });
  return { status, history, config };
}

function LastRun({ source }: { source: ScraperSourceStatus }) {
  const { active_run: active, last_run: last } = source;
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      {active && (
        <p className="text-info">
          {stateLabel(active.state)} — {active.cities.join(', ')}
          {active.started_at ? ` · ${fmtAgo(active.started_at)} başladı` : ''}
        </p>
      )}
      {last ? (
        <p>
          Son tarama {fmtAgo(last.finished_at)}: {runSummary(last)}
        </p>
      ) : (
        !active && <p className="text-ink-soft">Henüz taranmadı.</p>
      )}
      {last?.error_summary && last.state !== 'succeeded' && <p className={cn('break-words', TONE_TEXT[healthOf(source.health).tone])}>{last.error_summary}</p>}
      <p className="text-ink-soft">
        {source.active_jobs} etkin ilan, son 24 saatte {source.new_jobs_24h} yeni ·{' '}
        {source.next_run_at ? `sıradaki otomatik tarama ${fmtUntil(source.next_run_at)}` : source.enabled ? 'tarama sürüyor' : 'otomatik tarama kapalı'}
      </p>
    </div>
  );
}

function SourceRow({ source, busy, onRun, onPatch }: { source: ScraperSourceStatus; busy: boolean; onRun: () => void; onPatch: (patch: Record<string, unknown>) => void }) {
  const health = healthOf(source.health);
  if (!source.server_scraping)
    return (
      <SubSection title={source.label} action={<Badge tone="neutral">Yalnızca eklenti</Badge>}>
        <p className="text-sm text-ink-soft">{EXTENSION_ONLY_NOTE}</p>
      </SubSection>
    );
  return (
    <SubSection
      title={source.label}
      action={
        <div className="flex items-center gap-2">
          <Badge tone={health.tone}>{health.label}</Badge>
          <Button size="sm" variant="ghost" disabled={busy || !!source.active_run} icon={<Play className="size-4" aria-hidden />} onClick={onRun}>
            Şimdi tara
          </Button>
        </div>
      }
    >
      <LastRun source={source} />
      <Switch checked={source.enabled} disabled={busy} onChange={(enabled) => onPatch({ sources: { [source.source]: { enabled } } })} label="Otomatik tarama" description={keywordNote(source)} />
      <div className="flex flex-wrap gap-4">
        <LimitField label="Aralık (saat)" hint="Son taramadan bu kadar sonra yeniden taranır." value={source.interval_hours} options={INTERVAL_OPTIONS} disabled={busy} onChange={(interval_hours) => onPatch({ sources: { [source.source]: { interval_hours } } })} />
        <LimitField label="Şehir başına sayfa" hint="Her şehirde en çok bu kadar sonuç sayfası okunur." value={source.max_pages} options={PAGE_OPTIONS} disabled={busy} onChange={(max_pages) => onPatch({ sources: { [source.source]: { max_pages } } })} />
      </div>
    </SubSection>
  );
}

function RunsTable({ runs }: { runs: ScraperRunView[] }) {
  if (!runs.length) return <p className="text-sm text-ink-soft">Henüz tarama yapılmadı.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-ink-soft">
            {RUN_HEADINGS.map((heading) => (
              <th key={heading} scope="col" className="py-1 pr-3 font-medium">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {runs.map((run) => (
            <tr key={run.id}>
              <td className="py-1.5 pr-3 whitespace-nowrap">{fmtDateTime(run.finished_at ?? run.queued_at)}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap">{runSourceLabel(run)}</td>
              <td className={cn('py-1.5 pr-3 whitespace-nowrap', TONE_TEXT[stateTone(run.state)])}>{stateLabel(run.state)}</td>
              <td className="py-1.5 pr-3">{run.finished_at ? runSummary(run) : '-'}</td>
              <td className="py-1.5 text-ink-soft">{errorKinds(run) || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TargetsEditor({ config, busy, onPatch }: { config: ScraperConfig; busy: boolean; onPatch: (patch: Record<string, unknown>) => void }) {
  return (
    <SubSection title="Şehirler ve anahtar kelimeler" description="İki sitede de aynı liste kullanılır. Taranan ilanlardan yalnızca profildeki unvanlara ve şehirlere uyanlar listene eklenir.">
      <fieldset disabled={busy} className="flex flex-col gap-3">
        <TagsInput label="Şehirler" values={config.cities} onChange={(cities) => onPatch({ cities })} hint="Sıra önemlidir: site bir şehirde engellerse tarama orada durur." />
        <TagsInput label="Anahtar kelimeler (isteğe bağlı)" values={config.keywords} onChange={(keywords) => onPatch({ keywords })} placeholder="ör. Flutter Developer" />
      </fieldset>
    </SubSection>
  );
}

/**
 * İlan sitelerinin (Kariyer.net, Indeed, Eleman.net, İşin Olsun, Secretcv; Yenibiriş yalnızca eklentiyle) herkese açık arama sayfalarının taraması: site başına durum, son çalışmanın ölçümleri,
 * elle tarama ve ayarlar. Site engellerse (CAPTCHA, 403) tarama durur ve burada nedeniyle görünür.
 */
export function ScrapersAdminSection() {
  const { status, history, config } = useScrapers();
  const { busy, run } = useAction();
  const refreshAdmin = useAdminRefresh();
  const refresh = () => refreshAdmin(adminKeys.scrapers);

  const patch = (body: Record<string, unknown>) =>
    run(
      async () => {
        await adminApi.saveScraperConfig(body);
        await refresh();
      },
      { refresh: false, success: 'Tarama ayarı kaydedildi' },
    );
  const scan = (source: string) =>
    run(
      async () => {
        const result = await adminApi.runScrapers({ source: source as ScraperSource });
        await refresh();
        return result;
      },
      { refresh: false, success: (r) => (r?.runs.some((x) => x.already_running) ? 'Bu site zaten taranıyor' : 'Tarama sıraya alındı') },
    );

  return (
    <Section title="İlan siteleri taraması">
      <p className="text-sm text-ink-soft">
        İlan sitelerinin oturum açmadan görülebilen arama sayfaları belirli aralıklarla taranır; robots.txt'in izin vermediği sayfalar okunmaz. Site erişimi engellerse (güvenlik doğrulaması, 403) tarama durur, sana bildirilir ve bir gün beklenir; engel aşılmaya çalışılmaz. Bu sitelerin
        eksiksiz kaynağı yine iş alarmı mailleridir.
      </p>
      <Loaded query={status}>
        {(data) => (
          <>
            {!data.server_enabled && (
              <Notice tone="warn" icon={<CircleAlert className="size-5 shrink-0" aria-hidden />}>
                Tarama sunucuda kapalı (SCRAPERS_ENABLED=false).
              </Notice>
            )}
            {data.server_enabled && (
              <Switch checked={data.enabled} disabled={busy} onChange={(enabled) => void patch({ enabled })} label="Taramalar açık" description="Kapalıyken ne otomatik ne elle başlatılan tarama sitelere istek atar." />
            )}
            {data.sources.map((source) => (
              <div key={source.source} className="flex flex-col gap-4">
                <Divider />
                <SourceRow source={source} busy={busy} onRun={() => void scan(source.source)} onPatch={(body) => void patch(body)} />
              </div>
            ))}
          </>
        )}
      </Loaded>
      <Divider />
      <Loaded query={config}>{(data) => <TargetsEditor config={data} busy={busy} onPatch={(body) => void patch(body)} />}</Loaded>
      <Divider />
      <SubSection title="Son taramalar">
        <Loaded query={history}>{(data) => <RunsTable runs={data.items} />}</Loaded>
      </SubSection>
    </Section>
  );
}
