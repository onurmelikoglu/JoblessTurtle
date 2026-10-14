import { CircleCheck, CirclePause, Download, RefreshCw } from 'lucide-react';
import { adminApi } from '@/api/admin';
import { useAction } from '@/api/queries';
import type { LearnedModelSummary, LearningOverview } from '@/api/types';
import { cn } from '@/lib/cn';
import { saveBlob } from '@/lib/download';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/ui/Button';
import { TONE_TEXT } from '@/ui/tones';
import { adminKeys, useAdminRefresh, useLearning } from './admin-queries';
import { bounceText, effectText, effectTone, modelStatus, modelTitle, percent, weekLabel } from './learning-model';
import { Divider, ListRow, Loaded, Section, SubSection } from './parts';

const WEEK_HEADINGS = ['Hafta', 'Gönderim', 'Ulaşan', 'Geri dönen', 'Bekleyen', 'Yanıt', 'Geri dönüş oranı'];

function ModelRow({ model }: { model: LearnedModelSummary }) {
  return (
    <li>
      <ListRow leading={model.active ? <CircleCheck className="size-5 shrink-0 text-good" aria-hidden /> : <CirclePause className="size-5 shrink-0 text-ink-faint" aria-hidden />} title={modelTitle(model)} subtitle={modelStatus(model)} />
      {model.effects.length > 0 && (
        <ul className="mb-2 ml-8 flex flex-col gap-0.5 text-[13px]">
          {model.effects.map((effect) => (
            <li key={`${effect.feature}=${effect.value}`} className={TONE_TEXT[effectTone(effect, model.baseRate)]}>
              {effectText(effect)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function WeeklyTable({ rows }: { rows: LearningOverview['weekly'] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-ink-soft">
            {WEEK_HEADINGS.map((heading, index) => (
              <th key={heading} scope="col" className={cn('py-1 pr-3 font-medium', index > 0 && 'text-right')}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr key={row.week}>
              <td className="py-1.5 pr-3 whitespace-nowrap">{weekLabel(row)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{row.sent}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{row.delivered}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{row.bounced}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{row.pending}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{row.replied}</td>
              <td className="py-1.5 text-right tabular-nums">{bounceText(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Öğrenen sistemin durumu: kaç kayıt birikti, hangi model kullanılıyor ve ne kadar isabetli, istemlere ne eklendi. */
export function LearningAdminSection() {
  const learning = useLearning();
  const { busy, run } = useAction();
  const refreshAdmin = useAdminRefresh();

  const train = () =>
    run(
      async () => {
        await adminApi.trainModels();
        await refreshAdmin(adminKeys.learning);
      },
      { refresh: false, success: 'Modeller yeniden eğitildi' },
    );
  const download = () => run(async () => saveBlob(await adminApi.exportLearning(), `jobless-turtle-veri-seti-${new Date().toISOString().slice(0, 10)}.jsonl`), { refresh: false });

  return (
    <Section title="Öğrenme">
      <p className="text-sm text-ink-soft">
        Her gönderim, adres araması ve keşif sonucuyla birlikte kaydedilir. Modeller her gece bu kayıtlardan yeniden eğitilir; bir model ancak eğitimde görmediği örneklerde temel orandan iyi tahmin ediyorsa kullanılmaya başlar, aksi halde hiçbir kararı değiştirmez.
      </p>
      <Loaded query={learning}>
        {(overview) => (
          <>
            <SubSection title="Biriken kayıtlar">
              <p className="text-sm">{overview.events.length === 0 ? 'Henüz kayıt yok.' : overview.events.map((e) => `${e.label} ${e.total}${e.resolved < e.total ? ` (${e.resolved} sonuçlandı)` : ''}`).join(' · ')}</p>
            </SubSection>
            <Divider />
            <SubSection
              title="Modeller"
              description={overview.trainedAt ? `Son eğitim: ${fmtDateTime(overview.trainedAt)}` : 'Henüz eğitilmedi; ilk eğitim gece turunda yapılır.'}
              action={
                <Button variant="ghost" size="sm" disabled={busy} icon={<RefreshCw className="size-4" aria-hidden />} onClick={train}>
                  Şimdi eğit
                </Button>
              }
            >
              <ul>
                {overview.models.map((model) => (
                  <ModelRow key={`${model.name}:${model.scope ?? ''}`} model={model} />
                ))}
              </ul>
            </SubSection>
            {overview.weekly.length > 0 && (
              <>
                <Divider />
                <SubSection title="Haftalık gönderim sonuçları" description="Geri dönüş oranı, gönderilenler içinde adrese ulaşmayanların payıdır. Bekleyenler: geri dönüş gelmediği için 72 saat sonra ulaşmış sayılacak gönderimler.">
                  <WeeklyTable rows={overview.weekly} />
                </SubSection>
              </>
            )}
            <Divider />
            <SubSection title="İstemlere eklenen deneyim" description="Geçmiş sonuçlardan çıkan ipuçları adres aramasının istemine eklenir; yanıt almış başvurularındaki paragraflar yeni yazılar için ton örneği olur.">
              {overview.hints.contactSearch.length === 0 ? (
                <p className="text-sm text-ink-soft">Henüz ipucu çıkaracak kadar belirgin bir fark yok.</p>
              ) : (
                <ul className="list-disc pl-5 text-sm">
                  {overview.hints.contactSearch.map((hint) => (
                    <li key={hint}>{hint}</li>
                  ))}
                </ul>
              )}
              {overview.promptVariants.length > 0 && (
                <ul className="text-[13px] text-ink-soft">
                  {overview.promptVariants.map((variant) => (
                    <li key={`${variant.kind}:${variant.hints}`}>
                      {variant.label} — {variant.hints ? 'ipuçlu' : 'ipuçsuz'}: {variant.runs} arama, {percent(variant.successRate)} başarılı
                    </li>
                  ))}
                </ul>
              )}
            </SubSection>
            <Divider />
            <SubSection title="Veri seti" description="Yapay zekâ görevlerinin istemi, kabul edilmiş çıktısı ve gerçek sonucu satır satır (JSONL). İleride küçük bir modelin ince ayarında kullanılabilir. Dosya aday ve firma bilgisi içerir; paylaşmadan önce gözden geçir.">
              <div>
                <Button size="sm" disabled={busy || overview.exportable === 0} icon={<Download className="size-4" aria-hidden />} onClick={download}>
                  {overview.exportable === 0 ? 'Dışa aktarılacak kayıt yok' : `JSONL indir (en çok ${overview.exportable} kayıt)`}
                </Button>
              </div>
            </SubSection>
          </>
        )}
      </Loaded>
    </Section>
  );
}
