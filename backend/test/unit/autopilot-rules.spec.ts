import { AI_CLASSES, aiClassOf, budgetBlock, dailyCeiling, dailyShare, utilizationAllows, utilizationOpensAt } from '../../src/domain/ai-budget';
import { decideFix, FixContext, MAILBOX_FULL_RETRY_DAYS, MAX_AUTO_FIXES, needsAi } from '../../src/domain/autopilot';
import { contactSearchPlan, rememberedDepth, SEARCH_VERSION } from '../../src/domain/contact-search';
import { INBOUND_CATEGORIES } from '../../src/domain/inbound';
import { escalationModelFor } from '../../src/engine/ai/ai.service';
import { AI_KINDS } from '../../src/engine/ai/schemas';
import { addressSearchExhausted } from '../../src/engine/research.service';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-10-14T09:00:00Z').getTime();
const daysAgo = (days: number) => new Date(NOW - days * DAY_MS).toISOString();

function situation(patch: Partial<FixContext>): FixContext {
  return { category: 'bad_address', sentTo: 'ik@firma.example', suggestedEmail: null, alternatives: [], attachments: { cv: 1, other: 1 }, autoFixes: 0, retriedSameAddress: false, canResearch: true, ...patch };
}

describe('otopilot: mail dönüşüne göre karar', () => {
  it('geçersiz adreste bilinen sıradaki adrese aynı yazı gider', () => {
    for (const category of ['bad_address', 'closed_address', 'bad_domain'] as const) {
      expect(decideFix(situation({ category, alternatives: ['kariyer@firma.example', 'info@firma.example'] }))).toMatchObject({ step: 'resend', toEmail: 'kariyer@firma.example', attachments: 'all', delayDays: 0 });
    }
  });

  it('bilinen adres yoksa bir kez yeni adres aranır; arama yapılmışsa durulur', () => {
    expect(decideFix(situation({}))).toMatchObject({ step: 'research' });
    expect(decideFix(situation({ canResearch: false }))).toMatchObject({ step: 'stop', code: 'no_address' });
  });

  it('firma başka adres bildirdiyse o adrese, bildirmediyse bilinen adrese gider', () => {
    expect(decideFix(situation({ category: 'address_changed', suggestedEmail: 'yeni@firma.example', alternatives: ['info@firma.example'] }))).toMatchObject({ step: 'resend', toEmail: 'yeni@firma.example' });
    expect(decideFix(situation({ category: 'address_changed', alternatives: ['info@firma.example'] }))).toMatchObject({ step: 'resend', toEmail: 'info@firma.example' });
    expect(decideFix(situation({ category: 'address_changed' }))).toMatchObject({ step: 'research' });
  });

  it('ek boyutu sorununda yalnızca CV ile aynı adrese gider; CV tek başına sığmıyorsa durur', () => {
    expect(decideFix(situation({ category: 'too_large' }))).toMatchObject({ step: 'resend', toEmail: 'ik@firma.example', attachments: 'cv_only' });
    expect(decideFix(situation({ category: 'too_large', attachments: { cv: 1, other: 0 } }))).toMatchObject({ step: 'stop', code: 'attachment_limit' });
  });

  it('dolu kutuda önce gecikmeli yeniden deneme, sonra diğer adres, o da yoksa durma', () => {
    expect(decideFix(situation({ category: 'mailbox_full', alternatives: ['info@firma.example'] }))).toMatchObject({ step: 'resend', toEmail: 'ik@firma.example', delayDays: MAILBOX_FULL_RETRY_DAYS });
    expect(decideFix(situation({ category: 'mailbox_full', retriedSameAddress: true, alternatives: ['info@firma.example'] }))).toMatchObject({ step: 'resend', toEmail: 'info@firma.example', delayDays: 0 });
    expect(decideFix(situation({ category: 'mailbox_full', retriedSameAddress: true }))).toMatchObject({ step: 'stop', code: 'mailbox_full' });
  });

  it('biçim talimatında yazı düzeltilir; kariyer sitesi isteyen firmada mail denemesi durur', () => {
    expect(decideFix(situation({ category: 'format_issue' }))).toMatchObject({ step: 'fix_format' });
    expect(decideFix(situation({ category: 'apply_elsewhere', alternatives: ['info@firma.example'] }))).toMatchObject({ step: 'use_link' });
  });

  it('nedeni kesin olmayan dönüşler yapay zekâ yorumuna ve kullanıcının onayına bırakılır', () => {
    for (const category of ['rejected', 'bounce_other', 'unknown'] as const) expect(decideFix(situation({ category, alternatives: ['info@firma.example'] }))).toMatchObject({ step: 'ai_review' });
  });

  it('firma yanıtları, ulaştı bildirimleri ve gecikmeler için düzeltme yapılmaz', () => {
    for (const category of ['human_reply', 'interview', 'rejection', 'do_not_contact', 'auto_reply', 'out_of_office', 'delayed'] as const) expect(decideFix(situation({ category }))).toEqual({ step: 'none' });
  });

  it('bir başvuru en fazla iki kez kendiliğinden düzeltilir', () => {
    const exhausted = situation({ autoFixes: MAX_AUTO_FIXES, alternatives: ['info@firma.example'] });
    expect(decideFix(exhausted)).toMatchObject({ step: 'stop', code: 'max_fixes' });
    expect(decideFix({ ...exhausted, category: 'format_issue' })).toMatchObject({ step: 'stop', code: 'max_fixes' });
    expect(decideFix({ ...exhausted, category: 'apply_elsewhere' })).toMatchObject({ step: 'use_link' });
    expect(decideFix({ ...exhausted, autoFixes: MAX_AUTO_FIXES - 1 })).toMatchObject({ step: 'resend' });
  });

  it('her kategori için bir karar vardır ve gerekçesi yazılıdır', () => {
    for (const category of INBOUND_CATEGORIES) {
      const decision = decideFix(situation({ category }));
      if (decision.step !== 'none') expect(decision.why.length).toBeGreaterThan(20);
    }
    expect(['fix_format', 'research', 'ai_review'].every((step) => needsAi(step as never))).toBe(true);
    expect(needsAi('resend')).toBe(false);
  });
});

describe('adres araması hafızası', () => {
  it('hiç aranmamış firmada arka plan araması tek basamak, derin arama üç basamaktır', () => {
    expect(contactSearchPlan(null, { deep: false }, NOW)).toEqual({ rungs: ['base'], skip: null });
    expect(contactSearchPlan({}, { deep: true }, NOW)).toEqual({ rungs: ['base', 'second', 'max'], skip: null });
  });

  it('yakın zamanda aynı derinlikte aranan firma yeniden aranmaz', () => {
    expect(contactSearchPlan({ contactsSearchedAt: daysAgo(5), contactsDepth: 'base' }, { deep: false }, NOW)).toEqual({ rungs: [], skip: 'recent' });
    expect(contactSearchPlan({ contactsSearchedAt: daysAgo(5), contactsDepth: 'max', contactsVersion: SEARCH_VERSION }, { deep: true }, NOW)).toEqual({ rungs: [], skip: 'exhausted' });
    expect(contactSearchPlan({ contactsSearchedAt: daysAgo(5), contactsDepth: 'max', contactsVersion: SEARCH_VERSION }, { deep: false }, NOW).skip).toBe('recent');
  });

  it('derin arama yalnızca daha önce denenmemiş basamaklardan sürer', () => {
    expect(contactSearchPlan({ contactsSearchedAt: daysAgo(5), contactsDepth: 'base' }, { deep: true }, NOW).rungs).toEqual(['second', 'max']);
    expect(contactSearchPlan({ contactsSearchedAt: daysAgo(5), contactsDepth: 'second' }, { deep: true }, NOW).rungs).toEqual(['max']);
  });

  it('süre dolunca arama baştan yapılır; kullanıcı ısrar ederse süre bir haftaya iner', () => {
    const memory = { contactsSearchedAt: daysAgo(10), contactsDepth: 'max' as const, contactsVersion: SEARCH_VERSION };
    expect(contactSearchPlan(memory, { deep: true }, NOW).skip).toBe('exhausted');
    expect(contactSearchPlan(memory, { deep: true, force: true }, NOW).rungs).toEqual(['base', 'second', 'max']);
    expect(contactSearchPlan({ ...memory, contactsSearchedAt: daysAgo(3) }, { deep: true, force: true }, NOW).skip).toBe('exhausted');
    expect(contactSearchPlan({ ...memory, contactsSearchedAt: daysAgo(31) }, { deep: true }, NOW).rungs).toEqual(['base', 'second', 'max']);
  });

  it('adres geri döndükten sonraki arama, önceki aramadan bağımsızdır', () => {
    const memory = { contactsSearchedAt: daysAgo(4), contactsDepth: 'max' as const, contactsVersion: SEARCH_VERSION };
    expect(contactSearchPlan(memory, { deep: true, since: new Date(NOW - 2 * DAY_MS) }, NOW).rungs).toEqual(['base', 'second', 'max']);
    expect(contactSearchPlan(memory, { deep: true, since: new Date(NOW - 6 * DAY_MS) }, NOW).skip).toBe('exhausted');
  });

  it('derinlik alanından önceki kayıtlar okunur', () => {
    expect(rememberedDepth({ contactsSearchedAt: daysAgo(1), contactsEscalated: true, contactsVersion: SEARCH_VERSION })).toBe('max');
    expect(rememberedDepth({ contactsSearchedAt: daysAgo(1) })).toBe('base');
    expect(rememberedDepth({})).toBeNull();
    expect(addressSearchExhausted({ contactsSearchedAt: daysAgo(2), contactsEscalated: true, contactsVersion: SEARCH_VERSION }, NOW)).toBe(true);
    expect(addressSearchExhausted({ contactsSearchedAt: daysAgo(40), contactsEscalated: true }, NOW)).toBe(false);
    expect(addressSearchExhausted({ contactsSearchedAt: daysAgo(2), contactsDepth: 'second' }, NOW)).toBe(false);
  });

  it('eski yöntemle tükenmiş sayılan derin arama yeni yöntemle bir kez daha yapılabilir; arka plan araması yine beklenir', () => {
    const old = { contactsSearchedAt: daysAgo(2), contactsDepth: 'max' as const };
    expect(rememberedDepth(old)).toBe('second');
    expect(contactSearchPlan(old, { deep: true }, NOW)).toEqual({ rungs: ['max'], skip: null });
    expect(contactSearchPlan(old, { deep: false }, NOW).skip).toBe('recent');
    expect(addressSearchExhausted(old, NOW)).toBe(false);
    expect(addressSearchExhausted({ contactsSearchedAt: daysAgo(2), contactsEscalated: true }, NOW)).toBe(false);
  });
});

describe('yapay zekâ öncelik sınıfları', () => {
  it('her görev türünün bir sınıfı vardır', () => {
    expect(AI_KINDS.map((kind) => [kind, aiClassOf(kind)]).filter(([, cls]) => !AI_CLASSES.includes(cls as never))).toEqual([]);
    expect(aiClassOf('inbound_fix')).toBe('fix');
    expect(aiClassOf('mail_draft')).toBe('letters');
    expect(aiClassOf('company_contacts')).toBe('research');
    expect(aiClassOf('job_search')).toBe('discovery');
  });

  it('günlük hak daraldıkça önce keşif, sonra araştırma ve yazı durur; etkileşimli işler en son durur', () => {
    const stoppedAt = (usedTotal: number) => AI_CLASSES.filter((cls) => budgetBlock(cls, { dailyLimit: 100, usedTotal, usedByClass: 0 }) === 'daily');
    expect(stoppedAt(49)).toEqual([]);
    expect(stoppedAt(50)).toEqual(['discovery']);
    expect(stoppedAt(65)).toEqual(['research', 'discovery']);
    expect(stoppedAt(75)).toEqual(['letters', 'research', 'discovery']);
    expect(stoppedAt(95)).toEqual(['fix', 'letters', 'research', 'discovery']);
    expect(stoppedAt(100)).toEqual([...AI_CLASSES]);
  });

  it('bir sınıf günün hakkını tek başına tüketemez', () => {
    expect(budgetBlock('discovery', { dailyLimit: 100, usedTotal: 20, usedByClass: 20 })).toBe('share');
    expect(budgetBlock('discovery', { dailyLimit: 100, usedTotal: 19, usedByClass: 19 })).toBeNull();
    expect(budgetBlock('interactive', { dailyLimit: 100, usedTotal: 99, usedByClass: 99 })).toBeNull();
  });

  it('küçük günlük hakta da her sınıf en az bir görev çalıştırabilir; hak sıfırsa hiçbiri çalışmaz', () => {
    for (const cls of AI_CLASSES) {
      expect(dailyCeiling(cls, 1)).toBe(1);
      expect(dailyShare(cls, 1)).toBe(1);
      expect(dailyCeiling(cls, 0)).toBe(0);
    }
  });

  it('abonelik penceresi doldukça düşük öncelikli sınıflar sağlayıcıyı bırakır', () => {
    const resetsAt = new Date(NOW + 3_600_000).toISOString();
    const open = (utilization: number) => AI_CLASSES.filter((cls) => utilizationAllows(cls, [{ name: 'five_hour', utilization, resetsAt }], NOW));
    expect(open(0.5)).toEqual([...AI_CLASSES]);
    expect(open(0.65)).toEqual(['interactive', 'fix', 'letters', 'research']);
    expect(open(0.75)).toEqual(['interactive', 'fix', 'letters']);
    expect(open(0.85)).toEqual(['interactive', 'fix']);
    expect(open(0.89)).toEqual(['interactive']);
    expect(open(0.95)).toEqual([]);
  });

  it('süresi dolmuş pencere sayılmaz; yeniden açılma zamanı en geç sıfırlanan dolu penceredir', () => {
    const past = new Date(NOW - 1000).toISOString();
    const soon = new Date(NOW + 3_600_000).toISOString();
    const later = new Date(NOW + 5 * 3_600_000).toISOString();
    expect(utilizationAllows('discovery', [{ name: 'five_hour', utilization: 0.99, resetsAt: past }], NOW)).toBe(true);
    expect(utilizationAllows('discovery', null, NOW)).toBe(true);
    const windows = [{ name: 'five_hour', utilization: 0.8, resetsAt: soon }, { name: 'seven_day', utilization: 0.75, resetsAt: later }];
    expect(utilizationOpensAt('research', windows, NOW)?.toISOString()).toBe(later);
    expect(utilizationOpensAt('letters', windows, NOW)?.toISOString()).toBe(soon);
    expect(utilizationOpensAt('interactive', windows, NOW)).toBeNull();
  });

  it('çıktısı reddedilen hafif model bir üst modelle yeniden denenir', () => {
    expect(escalationModelFor('cli_claude', 'haiku')).toBe('sonnet');
    expect(escalationModelFor('cli_claude', 'sonnet')).toBeUndefined();
    expect(escalationModelFor('cli_codex', 'gpt-6.1-sol')).toBeUndefined();
    expect(escalationModelFor('ollama', 'haiku')).toBeUndefined();
  });
});
