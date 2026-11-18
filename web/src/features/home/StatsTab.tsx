import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { homeApi } from '@/api/home';
import type { StatsOverview, StatsRange } from '@/api/types';
import { cn } from '@/lib/cn';
import { LoadError, LoadingBlock } from '@/ui/feedback';
import { Panel } from '@/ui/Panel';

const RANGE_LABELS: Record<StatsRange, string> = { '30d': 'Son 30 gün', '90d': 'Son 90 gün', all: 'Tümü' };
const WEEKDAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
const WEEKDAY_NAMES = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
const HOURS = Array.from({ length: 16 }, (_, i) => i + 7);
const SEQUENTIAL_STEPS = ['opacity-20', 'opacity-40', 'opacity-60', 'opacity-80', 'opacity-100'];

const pct = (rate: number) => `%${Math.round(rate * 100)}`;
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Panel>
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {hint && <p className="text-xs text-ink-soft">{hint}</p>}
        </div>
        {children}
      </section>
    </Panel>
  );
}

function Funnel({ steps }: { steps: StatsOverview['funnel'] }) {
  const sent = steps[0]?.count ?? 0;
  return (
    <ul className="flex flex-col gap-2">
      {steps.map((s) => (
        <li key={s.key} className="grid grid-cols-[7rem_1fr_auto] items-center gap-3 text-sm" title={`${s.label}: ${s.count}${sent ? ` (gönderilenlerin ${pct(s.count / sent)})` : ''}`}>
          <span className="text-ink-soft">{s.label}</span>
          <span className="h-5 rounded-r bg-sunken">
            <span className="block h-full rounded-r bg-brand" style={{ width: sent ? `${Math.max((s.count / sent) * 100, s.count ? 1 : 0)}%` : '0%' }} />
          </span>
          <span className="w-20 text-right tabular-nums">
            {s.count}
            {sent > 0 && s.key !== 'sent' && <span className="text-ink-soft"> · {pct(s.count / sent)}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RateTable({ rows }: { rows: StatsOverview['rates'][number]['rows'] }) {
  if (!rows.length) return <p className="text-sm text-ink-soft">Henüz yeterli başvuru yok.</p>;
  const max = Math.max(...rows.map((r) => r.rate), 0.01);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-ink-soft">
          <th className="py-1 font-medium">Grup</th>
          <th className="py-1 text-right font-medium">Gönderim</th>
          <th className="py-1 text-right font-medium">Yanıt</th>
          <th className="w-1/3 py-1 pl-3 font-medium">Yanıt oranı</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-line" title={`${r.label}: ${r.sent} başvurudan ${r.replied} yanıt (${pct(r.rate)})`}>
            <td className="py-1.5 pr-2 break-words">{r.label}</td>
            <td className="py-1.5 text-right tabular-nums">{r.sent}</td>
            <td className="py-1.5 text-right tabular-nums">{r.replied}</td>
            <td className="py-1.5 pl-3">
              <span className="flex items-center gap-2">
                <span className="h-2 flex-1 rounded-r bg-sunken">
                  <span className="block h-full rounded-r bg-brand" style={{ width: `${(r.rate / max) * 100}%` }} />
                </span>
                <span className="w-10 text-right tabular-nums">{pct(r.rate)}</span>
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Weekly({ weeks }: { weeks: StatsOverview['weekly'] }) {
  if (!weeks.length) return <p className="text-sm text-ink-soft">Bu dönemde gönderim yok.</p>;
  const max = Math.max(...weeks.map((w) => w.sent), 1);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-32 items-end gap-1 border-b border-line" role="img" aria-label="Haftalık gönderim sayısı">
        {weeks.map((w) => (
          <span key={w.week} className="flex h-full max-w-10 min-w-2 flex-1 items-end" title={`${w.week} haftası: ${w.sent} gönderim, ${w.replied} yanıt, ${w.failed} geri dönen`}>
            <span className="block w-full rounded-t bg-brand" style={{ height: `${(w.sent / max) * 100}%` }} />
          </span>
        ))}
      </div>
      <p className="flex justify-between text-xs text-ink-soft">
        <span>{weeks[0].week}</span>
        <span>{weeks[weeks.length - 1].week}</span>
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer text-ink-soft">Tablo olarak göster</summary>
        <table className="mt-2 w-full">
          <thead>
            <tr className="text-left text-xs text-ink-soft">
              <th className="py-1 font-medium">Hafta</th>
              <th className="py-1 text-right font-medium">Gönderim</th>
              <th className="py-1 text-right font-medium">Yanıt</th>
              <th className="py-1 text-right font-medium">Geri dönen</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.week} className="border-t border-line tabular-nums">
                <td className="py-1">{w.week}</td>
                <td className="py-1 text-right">{w.sent}</td>
                <td className="py-1 text-right">{w.replied}</td>
                <td className="py-1 text-right">{w.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function SendTime({ sendTime }: { sendTime: StatsOverview['sendTime'] }) {
  const cell = new Map(sendTime.grid.map((c) => [`${c.weekday}:${c.hour}`, c]));
  const maxSent = Math.max(...sendTime.grid.map((c) => c.sent), 1);
  const s = sendTime.suggestion;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        {s
          ? `Önerilen gönderim zamanı: ${WEEKDAY_NAMES[s.weekday]} ${hourLabel(s.fromHour)}–${hourLabel(s.toHour)} (${s.sent} gönderimde yanıt oranı ${pct(s.rate)}).`
          : `Gönderim saati önerisi için en az ${sendTime.repliesNeeded} yanıt gerekiyor; şu an ${sendTime.replies}. Aşağıda şimdiye kadar ne zaman gönderdiğin görünüyor.`}
      </p>
      <div className="overflow-x-auto">
        <table className="text-[11px]" aria-label="Gün ve saate göre gönderim">
          <thead>
            <tr>
              <th />
              {HOURS.map((h) => (
                <th key={h} className="px-0.5 font-normal text-ink-soft">
                  {h % 3 === 0 ? h : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WEEKDAYS.map((day, weekday) => (
              <tr key={day}>
                <th className="pr-2 text-left font-normal text-ink-soft">{day}</th>
                {HOURS.map((hour) => {
                  const c = cell.get(`${weekday}:${hour}`);
                  const step = c ? SEQUENTIAL_STEPS[Math.min(SEQUENTIAL_STEPS.length - 1, Math.floor((c.sent / maxSent) * SEQUENTIAL_STEPS.length))] : null;
                  return (
                    <td key={hour} className="p-px">
                      <span
                        className={cn('block size-5 rounded-sm', c ? 'bg-brand' : 'bg-sunken', step)}
                        title={`${WEEKDAY_NAMES[weekday]} ${hourLabel(hour)}: ${c ? `${c.sent} gönderim, ${c.replied} yanıt` : 'gönderim yok'}`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-soft">Renk koyulaştıkça o saatte daha çok başvuru gönderilmiş. Saatler Türkiye saatidir.</p>
    </div>
  );
}

/** Kişisel istatistikler: huni, yanıt oranları, haftalık gidişat, gönderim saati ve yapay zekâ kullanımı. */
export function StatsTab() {
  const [range, setRange] = useState<StatsRange>('90d');
  const query = useQuery({ queryKey: ['home', 'stats', range], queryFn: () => homeApi.stats(range) });
  const data = query.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Dönem">
        {(Object.keys(RANGE_LABELS) as StatsRange[]).map((r) => (
          <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)} className={cn('h-8 rounded-full border px-3 text-[13px]', range === r ? 'border-brand bg-brand-soft text-brand-strong' : 'border-line-strong text-ink-soft hover:bg-sunken')}>
            {RANGE_LABELS[r]}
          </button>
        ))}
      </div>
      {query.isError && !data ? (
        <LoadError label="İstatistikler" onRetry={() => void query.refetch()} />
      ) : !data ? (
        <LoadingBlock label="İstatistikler hesaplanıyor…" />
      ) : (
        <>
          <Section title="Başvuru hunisi" hint="Gönderilen başvuruların kaçı ulaştı, yanıt aldı, mülâkata ve teklife döndü.">
            <Funnel steps={data.funnel} />
          </Section>
          <Section title="Haftalık gönderim">
            <Weekly weeks={data.weekly} />
          </Section>
          <Section title="Gönderim zamanı" hint="Mail ile gönderilen başvurular; yanıt oranı en yüksek üç saatlik dilim önerilir.">
            <SendTime sendTime={data.sendTime} />
          </Section>
          <div className="grid gap-4 lg:grid-cols-2">
            {data.rates.map((r) => (
              <Section key={r.title} title={`Yanıt oranı: ${r.title.toLocaleLowerCase('tr')}`}>
                <RateTable rows={r.rows} />
              </Section>
            ))}
          </div>
          <p className="text-xs text-ink-soft">
            Bu dönemde yapay zekâ {data.ai.tasks} görev tamamladı{data.ai.costUsd > 0 ? ` (yaklaşık ${data.ai.costUsd.toLocaleString('tr-TR')} $)` : ''}.
          </p>
        </>
      )}
    </div>
  );
}
