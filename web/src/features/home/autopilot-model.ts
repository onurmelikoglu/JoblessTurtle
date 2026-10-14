import type { AiClassUsage, AutopilotActionItem, AutopilotMode, AutopilotState, PipelineCounts } from '@/api/types';
import { fmtTime, fmtUntil, toDate } from '@/lib/format';
import type { Tone } from '@/ui/tones';

export const MODE_INFO: Record<AutopilotMode, { label: string; tone: Tone; text: string; pendingHint: string | null }> = {
  auto: {
    label: 'Kendiliğinden düzeltiyor',
    tone: 'good',
    text: 'Geri dönen başvuruyu kendisi düzeltir: adres geçersizse firmanın doğrulanmış sıradaki İK adresine gönderir, adres yoksa bir kez yenisini arar, ek sığmadıysa yalnızca CV ile dener, firma biçim istediyse yazıyı düzenler. Emin olamadığını onayına bırakır.',
    pendingHint: 'Otopilot açılmadan önce gelen dönüşler ile kendiliğinden gönderilmesi uygun olmayan düzeltmeler.',
  },
  approval: {
    label: 'Onayını bekliyor',
    tone: 'warn',
    text: '"Otomatik başvur" kapalı olduğu için düzeltmeler hazırlanır ve onayına sunulur. Onayladığın düzeltme hemen gönderim sırasına girer.',
    pendingHint: null,
  },
  stopped: { label: 'Durduruldu', tone: 'bad', text: 'Acil durdurma açık: hiçbir düzeltme kendiliğinden gönderilmez; öneriler yine de hazırlanır.', pendingHint: null },
};

export const STATE_INFO: Record<AutopilotState, { label: string; tone: Tone }> = {
  proposed: { label: 'Onayını bekliyor', tone: 'warn' },
  running: { label: 'Uygulanıyor', tone: 'info' },
  executed: { label: 'Yeniden gönderildi', tone: 'good' },
  info: { label: 'Gönderilmedi', tone: 'neutral' },
  failed: { label: 'Uygulanamadı', tone: 'bad' },
  dismissed: { label: 'Vazgeçildi', tone: 'neutral' },
};

const WAITING_STATES: ReadonlySet<AutopilotState> = new Set(['proposed', 'running']);

/** Kullanıcının kararını bekleyen ya da şu an uygulanan öneriler, en yenisi üstte. */
export const waitingActions = (actions: AutopilotActionItem[]) => actions.filter((a) => WAITING_STATES.has(a.state));
export const approvableActions = (actions: AutopilotActionItem[]) => actions.filter((a) => a.state === 'proposed');
/** Günlük: otopilotun yaptıkları ve gönderim yapmadan kullanıcıya bıraktıkları. */
export const loggedActions = (actions: AutopilotActionItem[]) => actions.filter((a) => !WAITING_STATES.has(a.state) && a.state !== 'dismissed');

const RETRY_LABELS: Record<string, string> = {
  sending: 'gönderiliyor',
  provider_accepted: 'gönderildi',
  submission_unknown: 'gönderim sonucu belirsiz',
  replied: 'yanıt geldi',
  outcome_recorded: 'yanıt geldi',
  bounced: 'yine geri döndü',
  cancelled: 'gönderilmedi',
  blocked: 'gönderilemedi',
  failed_confirmed: 'gönderilemedi',
};

/** Yeniden gönderimin şu anki durumu; sıradaysa ne zaman gideceği. */
export function retryLabel(retry: AutopilotActionItem['retry'], now = Date.now()): string | null {
  if (!retry) return null;
  if (retry.state !== 'queued') return RETRY_LABELS[retry.state] ?? retry.state;
  const at = toDate(retry.scheduledAt);
  return at && at.getTime() > now + 60_000 ? `sırada · ${fmtUntil(at, now)}` : 'sırada';
}

export interface PipelineStep {
  key: keyof PipelineCounts;
  label: string;
  value: number;
  tone: Tone;
}

/** Zincirin aşamaları, akış sırasıyla: bulundu → adres → yazı → sıra → gönderim → sonuç. */
export function pipelineSteps(p: PipelineCounts): PipelineStep[] {
  const steps: PipelineStep[] = [
    { key: 'companies', label: 'Firma', value: p.companies, tone: 'neutral' },
    { key: 'withAddress', label: 'Adresi bilinen', value: p.withAddress, tone: 'neutral' },
    { key: 'noAddress', label: 'Adresi bulunamayan', value: p.noAddress, tone: 'warn' },
    { key: 'lettersReady', label: 'Yazısı hazır', value: p.lettersReady, tone: 'info' },
    { key: 'queued', label: 'Sırada', value: p.queued, tone: 'info' },
    { key: 'sent', label: 'Gönderilen', value: p.sent, tone: 'neutral' },
    { key: 'delivered', label: 'Ulaşan', value: p.delivered, tone: 'good' },
    { key: 'bounced', label: 'Geri dönen', value: p.bounced, tone: 'bad' },
    { key: 'replied', label: 'Yanıt gelen', value: p.replied, tone: 'good' },
  ];
  return steps.filter((step) => step.value > 0 || step.key === 'companies' || step.key === 'sent');
}

const CLASS_SHORT: Record<string, string> = { interactive: 'senin işlemlerin', fix: 'düzeltme', letters: 'yazı', research: 'araştırma', discovery: 'keşif' };

/** "Bugün 55 yapay zekâ görevi: araştırma 30 · yazı 20 · düzeltme 3 · keşif 2"; hiç kullanım yoksa null. */
export function aiUsageLine(classes: AiClassUsage[]): string | null {
  const used = classes.filter((c) => c.used > 0).sort((a, b) => b.used - a.used);
  if (!used.length) return null;
  const total = used.reduce((sum, c) => sum + c.used, 0);
  return `Bugün ${total} yapay zekâ görevi: ${used.map((c) => `${CLASS_SHORT[c.aiClass] ?? c.label} ${c.used}`).join(' · ')}`;
}

function listOf(names: string[]) {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} ve ${names[names.length - 1]}`;
}

/**
 * Öncelik gereği bekletilen işler varsa kullanıcıya nedeni: abonelik limitine yaklaşıldığında ya da günlük hak
 * daraldığında önce keşif ve araştırma durur, yazı hazırlama ve kullanıcının kendi işlemleri sürer.
 */
export function aiThrottleNotice(classes: AiClassUsage[]): string | null {
  const closed = classes.filter((c) => !c.open);
  if (!closed.length || closed.length === classes.length) return null;
  const names = listOf(closed.map((c) => CLASS_SHORT[c.aiClass] ?? c.label));
  const running = listOf(classes.filter((c) => c.open).map((c) => CLASS_SHORT[c.aiClass] ?? c.label));
  if (closed.every((c) => c.blockedBy === 'subscription')) {
    const opens = closed.map((c) => toDate(c.opensAt)).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0];
    return `Abonelik limitine yaklaşıldı: ${names} işleri ${opens ? `${fmtTime(opens)}'e kadar ` : ''}bekletiliyor; ${running} sürüyor.`;
  }
  return `Günlük yapay zekâ hakkı daraldı: ${names} işleri yarına kaldı; ${running} sürüyor.`;
}
