import { canTransition } from '../../src/domain/attempt-state';
import { evaluatePolicy, PolicyInput } from '../../src/domain/policy';

const now = new Date('2026-09-30T10:00:00Z');
const base: PolicyInput = {
  policy: {
    active: true,
    modeJobApplication: true,
    modeGeneralIntent: false,
    includeAdjacent: false,
    fMin: 85,
    qMin: 65,
    coverageMin: 0.6,
    allowedRecipientKinds: ['official_hr', 'job_apply'],
  },
  emergencyStop: false,
  intent: 'job_application',
  titleMatch: 'exact',
  job: { status: 'open', lastVerifiedAt: new Date(now.getTime() - 5 * 60_000), channel: 'email' },
  sourceHealthy: true,
  f: 90,
  q: 70,
  coverage: 0.7,
  mandatoryUnknown: false,
  mandatoryFailed: false,
  location: 'primary',
  unknownLocationAction: 'review',
  contact: { kind: 'official_hr', verified: true, suppressed: false },
  documentsReady: true,
  alreadyApplied: false,
  companyCooldownActive: false,
  dailyLimitReached: false,
  suppressed: false,
  accountHealthy: true,
  now,
};

describe('otomatik başvuru politikası', () => {
  it('tüm koşullar uygunsa gönderilebilir', () => {
    expect(evaluatePolicy(base)).toEqual({ eligible: true, reasons: [] });
  });

  it('yakın rol opt-in kapalıysa otomatik gönderim yok', () => {
    expect(evaluatePolicy({ ...base, titleMatch: 'adjacent' }).reasons).toContain('ADJACENT_NOT_ALLOWED');
  });

  it('konum belirsizse inceleme gerekir', () => {
    expect(evaluatePolicy({ ...base, location: 'unknown' }).reasons).toContain('LOCATION_UNKNOWN');
  });

  it('10 dakikadan eski doğrulama tazelik hatası verir', () => {
    const r = evaluatePolicy({ ...base, job: { ...base.job!, lastVerifiedAt: new Date(now.getTime() - 11 * 60_000) } });
    expect(r.reasons).toContain('FRESHNESS_STALE');
  });

  it('tahmin edilmiş / doğrulanmamış adres alıcıya dönüşmez', () => {
    expect(evaluatePolicy({ ...base, contact: { kind: 'guessed', verified: false, suppressed: false } }).reasons).toEqual(
      expect.arrayContaining(['CONTACT_UNVERIFIED', 'RECIPIENT_KIND_NOT_ALLOWED']),
    );
  });

  it('acil durdur, kaynak engeli, platform kanalı ve tekrar engeli', () => {
    const r = evaluatePolicy({
      ...base,
      emergencyStop: true,
      sourceHealthy: false,
      alreadyApplied: true,
      job: { ...base.job!, channel: 'platform' },
    });
    expect(r.reasons).toEqual(expect.arrayContaining(['EMERGENCY_STOP', 'SOURCE_BLOCKED', 'ALREADY_APPLIED', 'CHANNEL_MANUAL_ONLY']));
  });

  it('zorunlu koşul bilinmiyorsa yüksek F ile otomatik aşılmaz', () => {
    expect(evaluatePolicy({ ...base, f: 100, mandatoryUnknown: true }).reasons).toContain('MANDATORY_UNKNOWN');
  });

  it('genel niyet ayrı anahtardır', () => {
    expect(evaluatePolicy({ ...base, intent: 'general_intent', job: null }).reasons).toContain('MODE_DISABLED');
  });
});

describe('gönderim durum makinesi', () => {
  it('belirsiz gönderim tekrar kuyruğa dönemez', () => {
    expect(canTransition('submission_unknown', 'queued' as any)).toBe(false);
    expect(canTransition('submission_unknown', 'sending')).toBe(false);
    expect(canTransition('queued', 'sending')).toBe(true);
    expect(canTransition('sending', 'submission_unknown')).toBe(true);
    expect(canTransition('cancelled', 'sending')).toBe(false);
  });
});
