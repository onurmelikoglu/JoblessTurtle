import { describe, expect, it } from 'vitest';
import type { AiSetupStatus, ConnectStatus, IsoDate } from '@/api/types';
import { anyLoginInProgress, connectionSummary, extensionOutdated, pendingSteps, setupSteps, type SetupInput } from './setup-model';

const iso = (value: string) => value as IsoDate;

const ai = (patch: Partial<AiSetupStatus> = {}): AiSetupStatus => ({ ready: false, usable: [], manualAccepted: false, cliAllowed: true, canManage: true, connections: [], apiKeys: null, ...patch });

const input = (patch: Partial<SetupInput> = {}): SetupInput => ({
  home: { missing: [], mailAccount: { id: 'm1', accountEmail: 'deniz@ornek.test' } as SetupInput['home']['mailAccount'] },
  ai: ai({ ready: true, usable: ['cli_claude', 'anthropic_api'] }),
  extensionVersion: null,
  extensionKey: { exists: false, created_at: null, last_used_at: null },
  ...patch,
});

const connection = (patch: Partial<ConnectStatus> = {}): ConnectStatus => ({ provider: 'cli_claude', installed: true, connected: false, account: null, plan: null, login: null, ...patch });

describe('kurulum listesi', () => {
  it('her şey hazırsa yalnızca isteğe bağlı eklenti eksik kalır', () => {
    const steps = setupSteps(input());
    expect(steps.map((s) => [s.id, s.done])).toEqual([
      ['profile', true],
      ['ai', true],
      ['mail', true],
      ['extension', false],
    ]);
    expect(steps[1].summary).toBe('Kullanılan: Claude (aboneliğin), Claude API.');
    expect(steps[2].summary).toBe('deniz@ornek.test bağlı.');
    expect(pendingSteps(steps, true)).toEqual([]);
  });

  it('eksik profil parçaları, mail ve yapay zekâ ana sayfa hatırlatmasına girer', () => {
    const steps = setupSteps(input({ home: { missing: ['cv', 'positions', 'mail'], mailAccount: null }, ai: ai() }));
    expect(steps[0].summary).toBe('Eksik: CV, aranan pozisyonlar.');
    expect(pendingSteps(steps, true).map((s) => s.id)).toEqual(['profile', 'ai', 'mail']);
  });

  it('yapay zekâ durumu yüklenmeden eksik sayılmaz; kopyala-yapıştır seçimi adımı tamamlar', () => {
    expect(pendingSteps(setupSteps(input({ ai: undefined })), false)).toEqual([]);
    const manual = setupSteps(input({ ai: ai({ manualAccepted: true }) }))[1];
    expect(manual.done).toBe(true);
    expect(manual.summary).toContain('Kopyala-yapıştır');
  });

  it('eklenti bu tarayıcıda algılanınca ya da anahtar kullanılmışsa tamam', () => {
    expect(setupSteps(input({ extensionVersion: '1.4.0' }))[3]).toMatchObject({ done: true, summary: 'Bu tarayıcıda kurulu ve eşleşmiş (sürüm 1.4.0).' });
    expect(setupSteps(input({ extensionKey: { exists: true, created_at: iso('2026-10-20T10:00:00Z'), last_used_at: iso('2026-10-21T10:00:00Z') } }))[3].done).toBe(true);
  });
});

describe('hesap bağlama durumu', () => {
  it('kart özeti', () => {
    expect(connectionSummary(connection({ installed: false }))).toBe('Bu sunucuda kurulu değil.');
    expect(connectionSummary(connection({ connected: true, account: 'deniz@ornek.test', plan: 'max' }))).toBe('deniz@ornek.test · max');
    expect(connectionSummary(connection({ provider: 'cli_codex', connected: true, plan: 'ChatGPT' }))).toBe('ChatGPT');
    const login = { phase: 'waiting' as const, url: 'https://claude.com/cai/oauth/authorize', userCode: null, needsCode: true, message: null, expiresAt: iso('2026-10-23T12:00:00Z') };
    expect(connectionSummary(connection({ login }))).toBe('Giriş sayfasındaki kodu bekliyor.');
    expect(connectionSummary(connection({ login: { ...login, needsCode: false } }))).toBe('Tarayıcıda onay bekleniyor.');
    expect(anyLoginInProgress([connection(), connection({ login })])).toBe(true);
    expect(anyLoginInProgress([connection({ login: { ...login, phase: 'expired' } })])).toBe(false);
  });

  it('eklenti sürüm karşılaştırması', () => {
    expect(extensionOutdated('1.3.0', '1.4.0')).toBe(true);
    expect(extensionOutdated('1.4.0', '1.4.0')).toBe(false);
    expect(extensionOutdated('1.10.0', '1.4.0')).toBe(false);
    expect(extensionOutdated(null, '1.4.0')).toBe(false);
  });
});
