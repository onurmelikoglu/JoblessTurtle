import { describe, expect, it } from 'vitest';
import type { AiClassUsage, AutopilotActionItem, HomeAi, IsoDate, PipelineCounts } from '@/api/types';
import { aiThrottleNotice, aiUsageLine, approvableActions, loggedActions, pipelineSteps, retryLabel, waitingActions } from './autopilot-model';
import { aiNotice } from './model';

const NOW = new Date('2026-10-14T09:00:00+03:00').getTime();
const iso = (time: number | string) => new Date(time).toISOString() as IsoDate;

function action(patch: Partial<AutopilotActionItem>): AutopilotActionItem {
  return {
    id: 'a1',
    messageId: 'm1',
    attemptId: 't1',
    companyId: 'c1',
    company: 'Örnek Ajans',
    category: 'bad_address',
    label: 'Adres bulunamadı',
    step: 'resend',
    state: 'proposed',
    approved: false,
    toEmail: 'ik@ornek.example',
    detail: 'Adres geçersiz çıktı; firmanın bilinen sıradaki adresine gönderilecek.',
    aiTasks: 0,
    usesAi: false,
    retry: null,
    createdAt: iso(NOW),
    executedAt: null,
    ...patch,
  };
}

function usage(aiClass: AiClassUsage['aiClass'], patch: Partial<AiClassUsage> = {}): AiClassUsage {
  return { aiClass, label: aiClass, used: 0, share: 10, open: true, blockedBy: null, opensAt: null, ...patch };
}

const ALL_OPEN = [usage('interactive'), usage('fix'), usage('letters'), usage('research'), usage('discovery')];

describe('otopilot: öneriler ve günlük', () => {
  const actions = [action({ id: 'p', state: 'proposed' }), action({ id: 'r', state: 'running' }), action({ id: 'e', state: 'executed' }), action({ id: 'i', state: 'info' }), action({ id: 'f', state: 'failed' }), action({ id: 'd', state: 'dismissed' })];

  it('onay bekleyenler ile uygulanmakta olanlar birlikte, yalnızca bekleyenler onaylanabilir', () => {
    expect(waitingActions(actions).map((a) => a.id)).toEqual(['p', 'r']);
    expect(approvableActions(actions).map((a) => a.id)).toEqual(['p']);
  });

  it('günlükte yapılanlar ve kullanıcıya bırakılanlar yer alır; vazgeçilenler gösterilmez', () => {
    expect(loggedActions(actions).map((a) => a.id)).toEqual(['e', 'i', 'f']);
  });

  it('yeniden gönderimin durumu ve planlanan zamanı okunur yazılır', () => {
    expect(retryLabel(null, NOW)).toBeNull();
    expect(retryLabel({ id: 'x', state: 'queued', scheduledAt: null }, NOW)).toBe('sırada');
    expect(retryLabel({ id: 'x', state: 'queued', scheduledAt: iso(NOW + 25 * 60_000) }, NOW)).toBe('sırada · 25 dk sonra');
    expect(retryLabel({ id: 'x', state: 'queued', scheduledAt: iso(NOW - 60_000) }, NOW)).toBe('sırada');
    expect(retryLabel({ id: 'x', state: 'provider_accepted', scheduledAt: null }, NOW)).toBe('gönderildi');
    expect(retryLabel({ id: 'x', state: 'bounced', scheduledAt: null }, NOW)).toBe('yine geri döndü');
    expect(retryLabel({ id: 'x', state: 'cancelled', scheduledAt: null }, NOW)).toBe('gönderilmedi');
  });
});

describe('otopilot: zincir özeti', () => {
  const counts: PipelineCounts = { companies: 320, withAddress: 250, noAddress: 0, lettersReady: 12, queued: 0, sent: 246, delivered: 180, bounced: 45, replied: 20 };

  it('aşamalar akış sırasıyla gelir; sayısı sıfır olan ara aşamalar gizlenir', () => {
    expect(pipelineSteps(counts).map((s) => [s.label, s.value])).toEqual([
      ['Firma', 320],
      ['Adresi bilinen', 250],
      ['Yazısı hazır', 12],
      ['Gönderilen', 246],
      ['Ulaşan', 180],
      ['Geri dönen', 45],
      ['Yanıt gelen', 20],
    ]);
  });

  it('henüz hiçbir şey yokken de firma ve gönderim sayısı görünür', () => {
    const empty: PipelineCounts = { companies: 0, withAddress: 0, noAddress: 0, lettersReady: 0, queued: 0, sent: 0, delivered: 0, bounced: 0, replied: 0 };
    expect(pipelineSteps(empty).map((s) => s.key)).toEqual(['companies', 'sent']);
  });
});

describe('yapay zekâ payı', () => {
  it('günün kullanımı sınıflara göre, çoktan aza yazılır', () => {
    expect(aiUsageLine(ALL_OPEN)).toBeNull();
    expect(aiUsageLine([usage('interactive', { used: 2 }), usage('fix', { used: 3 }), usage('letters', { used: 20 }), usage('research', { used: 30 }), usage('discovery')])).toBe('Bugün 55 yapay zekâ görevi: araştırma 30 · yazı 20 · düzeltme 3 · senin işlemlerin 2');
  });

  it('abonelik limitine yaklaşılınca hangi işlerin bekletildiği ve ne zamana kadar olduğu söylenir', () => {
    const opensAt = iso('2026-10-14T13:10:00+03:00');
    const classes = [usage('interactive'), usage('fix'), usage('letters'), usage('research', { open: false, blockedBy: 'subscription', opensAt }), usage('discovery', { open: false, blockedBy: 'subscription', opensAt })];
    expect(aiThrottleNotice(classes)).toBe("Abonelik limitine yaklaşıldı: araştırma ve keşif işleri 13:10'e kadar bekletiliyor; senin işlemlerin, düzeltme ve yazı sürüyor.");
  });

  it('günlük hak daraldığında bekletilen işler yarına kalır; her şey açıkken ya da kapalıyken ayrı not düşülmez', () => {
    const classes = [usage('interactive'), usage('fix'), usage('letters'), usage('research'), usage('discovery', { open: false, blockedBy: 'share' })];
    expect(aiThrottleNotice(classes)).toBe('Günlük yapay zekâ hakkı daraldı: keşif işleri yarına kaldı; senin işlemlerin, düzeltme, yazı ve araştırma sürüyor.');
    expect(aiThrottleNotice(ALL_OPEN)).toBeNull();
    expect(aiThrottleNotice(ALL_OPEN.map((c) => ({ ...c, open: false, blockedBy: 'daily' as const })))).toBeNull();
  });

  it('durum panelindeki uyarı önce limit ve bekleme bilgisini, yoksa öncelik gereği bekletilen işleri gösterir', () => {
    const ai: HomeAi = { automatic: true, usedToday: 10, dailyLimit: 100, limitReached: false, nearLimit: false, cooldowns: {}, limits: {}, classes: [usage('interactive'), usage('fix'), usage('letters'), usage('research'), usage('discovery', { open: false, blockedBy: 'share' })] };
    expect(aiNotice(ai)).toContain('keşif işleri yarına kaldı');
    expect(aiNotice({ ...ai, classes: ALL_OPEN })).toBeNull();
    expect(aiNotice({ ...ai, limitReached: true })).toContain('Bugünkü AI işlem hakkın doldu');
  });
});
