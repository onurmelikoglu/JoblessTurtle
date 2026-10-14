import { CircleCheck, CirclePause, RefreshCw } from 'lucide-react';
import type { AiStatus, AiUsage } from '@/api/types';
import { cn } from '@/lib/cn';
import { fmtCount, fmtDateTime } from '@/lib/format';
import { IconButton } from '@/ui/Button';
import { useAiStatus, useAiUsage } from './admin-queries';
import { AiModelsEditor } from './AiModelsEditor';
import { MODEL_PROVIDERS } from './constants';
import { Divider, ListRow, Loaded, Section, SubSection } from './parts';

const usd = (amount: number) => `$${amount.toFixed(2)}`;

function ProviderList({ providers, cooldowns }: { providers: AiStatus['providers']; cooldowns: AiUsage['cooldowns'] }) {
  return (
    <SubSection title="Sağlayıcılar">
      <ul>
        {MODEL_PROVIDERS.map(({ name, label }) => {
          const provider = providers.find((candidate) => candidate.name === name);
          const until = cooldowns[name];
          const ready = provider?.available === true && !until;
          return (
            <ListRow
              key={name}
              as="li"
              leading={ready ? <CircleCheck className="size-5 shrink-0 text-good" aria-hidden /> : <CirclePause className="size-5 shrink-0 text-ink-faint" aria-hidden />}
              title={`${label} (${provider?.label ?? name})`}
              subtitle={until ? `Limit nedeniyle ${fmtDateTime(until)} tarihine kadar beklemede; bu sürede sıradaki sağlayıcı kullanılıyor.` : provider?.detail}
            />
          );
        })}
      </ul>
      <p className="text-xs text-ink-soft">Sıra: Claude → ChatGPT → kopyala-yapıştır. Claude limit hatası verirse otomatik olarak ChatGPT kullanılır. ChatGPT için bir kez giriş gerekir: terminalde "docker compose exec -it worker codex login --device-auth".</p>
    </SubSection>
  );
}

const USAGE_HEADINGS = ['Görev', 'Model', 'Adet', 'Token (okunan / yazılan)', 'Maliyet'];
const MODEL_COLUMN = 1;

/** Dar ekranda model ayrı sütun yerine görev adının altında gösterilir; böylece tablo yana kaymadan sığar. */
function UsageTable({ rows }: { rows: AiUsage['rows'] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr>
            {USAGE_HEADINGS.map((heading, index) => (
              <th key={heading} scope="col" className={cn('p-0', index === MODEL_COLUMN && 'max-sm:hidden')}>
                <span className="sr-only">{heading}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => {
            const model = row.model ?? row.provider;
            return (
              <tr key={`${row.kind}:${row.provider}:${row.model ?? ''}`}>
                <td className="py-1.5 pr-3">
                  {row.kindLabel}
                  <span className="block text-ink-soft sm:hidden">{model}</span>
                </td>
                <td className="py-1.5 pr-3 text-ink-soft max-sm:hidden">{model}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{row.count}×</td>
                <td className="py-1.5 pr-3 text-right whitespace-nowrap tabular-nums">
                  {fmtCount(row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens)} / {fmtCount(row.outputTokens)}
                </td>
                <td className="py-1.5 text-right tabular-nums">{usd(row.costUsd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AiAdminSection() {
  const status = useAiStatus();
  const usage = useAiUsage();
  const refreshing = status.isFetching || usage.isFetching;
  const refresh = () => {
    void status.refetch();
    void usage.refetch();
  };

  return (
    <Section title="AI kullanımı ve modeller">
      <Loaded query={status}>
        {(aiStatus) => (
          <Loaded query={usage}>
            {({ rows, cooldowns }) => (
              <>
                <ProviderList providers={aiStatus.providers} cooldowns={cooldowns} />
                <Divider />
                <SubSection
                  title={`Son 24 saat (toplam ≈ ${usd(rows.reduce((sum, row) => sum + row.costUsd, 0))})`}
                  action={
                    <IconButton label="Yenile" size="sm" disabled={refreshing} onClick={refresh}>
                      <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} aria-hidden />
                    </IconButton>
                  }
                >
                  {rows.length === 0 ? <p className="text-sm text-ink-soft">Henüz kayıtlı kullanım yok; yeni AI işlemleri burada görünecek.</p> : <UsageTable rows={rows} />}
                  <p className="text-xs text-ink-soft">Token: okunan (önbellek dahil) / yazılan. Maliyet, abonelikte gerçek ödeme değil; Claude'un bildirdiği eşdeğer API fiyatıdır.</p>
                </SubSection>
                <Divider />
                <AiModelsEditor status={aiStatus} />
              </>
            )}
          </Loaded>
        )}
      </Loaded>
    </Section>
  );
}
