/**
 * Otomatik başvuru politikası değerlendirmesi — doküman §7.
 * Saf fonksiyon: kuyruğa alma öncesi ve worker'da gönderim çağrısından hemen önce aynı kurallar çalışır.
 */
import { selectionsMatching } from './geo';

export type ReasonCode =
  | 'POLICY_INACTIVE'
  | 'EMERGENCY_STOP'
  | 'MODE_DISABLED'
  | 'TITLE_EXCLUDED'
  | 'TITLE_NOT_MATCHED'
  | 'ADJACENT_NOT_ALLOWED'
  | 'JOB_NOT_OPEN'
  | 'SOURCE_BLOCKED'
  | 'FRESHNESS_STALE'
  | 'F_BELOW_THRESHOLD'
  | 'Q_BELOW_THRESHOLD'
  | 'COVERAGE_BELOW_THRESHOLD'
  | 'MANDATORY_UNKNOWN'
  | 'MANDATORY_FAILED'
  | 'LOCATION_UNKNOWN'
  | 'LOCATION_OUTSIDE'
  | 'CONTACT_MISSING'
  | 'CONTACT_UNVERIFIED'
  | 'RECIPIENT_KIND_NOT_ALLOWED'
  | 'CHANNEL_MANUAL_ONLY'
  | 'DOCUMENT_NOT_READY'
  | 'ALREADY_APPLIED'
  | 'COMPANY_COOLDOWN'
  | 'DAILY_LIMIT'
  | 'SUPPRESSED'
  | 'ACCOUNT_UNHEALTHY'
  | 'CITY_FILTERED'
  | 'WORK_MODE_FILTERED'
  | 'SIZE_FILTERED';

export const REASON_LABELS: Record<ReasonCode, string> = {
  POLICY_INACTIVE: 'Politika aktif değil',
  EMERGENCY_STOP: 'Acil durdur açık',
  MODE_DISABLED: 'Bu otomasyon modu kapalı',
  TITLE_EXCLUDED: 'Unvan hariç listesinde',
  TITLE_NOT_MATCHED: 'Unvan hedeflerle eşleşmiyor',
  ADJACENT_NOT_ALLOWED: 'Yakın rol için otomatik gönderim açık değil',
  JOB_NOT_OPEN: 'İlan açık değil',
  SOURCE_BLOCKED: 'Kaynak erişimi engelli/bozuk',
  FRESHNESS_STALE: 'İlan son 10 dakikada doğrulanmadı',
  F_BELOW_THRESHOLD: 'Rol uyumu (F) eşik altında',
  Q_BELOW_THRESHOLD: 'Firma kalitesi (Q) eşik altında',
  COVERAGE_BELOW_THRESHOLD: 'Kanıt kapsamı eşik altında',
  MANDATORY_UNKNOWN: 'Zorunlu koşul doğrulanmadı',
  MANDATORY_FAILED: 'Zorunlu koşul karşılanmıyor',
  LOCATION_UNKNOWN: 'Görev konumu belirsiz',
  LOCATION_OUTSIDE: 'Görev konumu hedef bölgelerin dışında',
  CONTACT_MISSING: 'Başvuru adresi yok',
  CONTACT_UNVERIFIED: 'Alıcı adresi doğrulanmadı',
  RECIPIENT_KIND_NOT_ALLOWED: 'Alıcı türü politikada izinli değil',
  CHANNEL_MANUAL_ONLY: 'Kaynak yalnızca platformda manuel başvuruyu destekliyor',
  DOCUMENT_NOT_READY: 'Belge taranmadı veya geçersiz',
  ALREADY_APPLIED: 'Bu ilana/amaca zaten başvuruldu',
  COMPANY_COOLDOWN: 'Firma için ilk temas aralığı dolmadı',
  DAILY_LIMIT: 'Günlük gönderim limiti doldu',
  SUPPRESSED: 'Kara liste / iletişime geçmeyin kaydı',
  ACCOUNT_UNHEALTHY: 'Gönderici hesabı geçersiz',
  CITY_FILTERED: 'İlanın şehri otomatik başvuru şehirlerinde değil',
  WORK_MODE_FILTERED: 'Çalışma şekli otomatik başvuru seçiminde değil',
  SIZE_FILTERED: 'Firmanın çalışan sayısı otomatik başvuru seçiminde değil',
};

export interface AutoApplyFilters {
  filterCities: string[];
  filterWorkModes: string[];
  filterSizes: string[];
  includeUnknownWorkMode: boolean;
  includeUnknownSize: boolean;
}

export interface FilterSubject {
  /** İlanın konum metni (şehir, ilçe ya da adres); yoksa null. */
  place: string | null;
  /** İlanda yazan çalışma şekli; yazmıyorsa 'unknown'. */
  workMode: string;
  employeeRange: string | null;
}

const KNOWN_WORK_MODES = ['onsite', 'hybrid', 'remote'];

/**
 * Kullanıcının otomatik başvuru filtreleri. Boş liste "hepsi" demektir. Uzaktan ilan şehir filtresine takılmaz; konumu
 * bilinmeyen ilan şehir filtresine de takılmaz (onu konum kuralı ayrıca değerlendirir).
 */
export function filterReasons(filters: AutoApplyFilters, subject: FilterSubject, intent: 'job_application' | 'general_intent'): ReasonCode[] {
  const reasons: ReasonCode[] = [];
  if (intent === 'job_application') {
    const remote = subject.workMode === 'remote';
    if (filters.filterCities.length && !remote && subject.place?.trim() && selectionsMatching(filters.filterCities, subject.place).length === 0) reasons.push('CITY_FILTERED');
    if (filters.filterWorkModes.length) {
      const known = KNOWN_WORK_MODES.includes(subject.workMode);
      if (known ? !filters.filterWorkModes.includes(subject.workMode) : !filters.includeUnknownWorkMode) reasons.push('WORK_MODE_FILTERED');
    }
  }
  if (filters.filterSizes.length) {
    if (subject.employeeRange ? !filters.filterSizes.includes(subject.employeeRange) : !filters.includeUnknownSize) reasons.push('SIZE_FILTERED');
  }
  return reasons;
}

export interface PolicyInput {
  policy: {
    active: boolean;
    modeJobApplication: boolean;
    modeGeneralIntent: boolean;
    includeAdjacent: boolean;
    fMin: number;
    qMin: number;
    coverageMin: number;
    allowedRecipientKinds: string[];
  };
  emergencyStop: boolean;
  intent: 'job_application' | 'general_intent';
  titleMatch: 'exact' | 'adjacent' | 'excluded' | 'none';
  job?: { status: string; lastVerifiedAt: Date | null; channel: string } | null;
  sourceHealthy: boolean;
  f: number | null;
  q: number | null;
  coverage: number | null;
  mandatoryUnknown: boolean;
  mandatoryFailed: boolean;
  location: string;
  unknownLocationAction: string;
  contact: { kind: string; verified: boolean; suppressed: boolean } | null;
  documentsReady: boolean;
  alreadyApplied: boolean;
  companyCooldownActive: boolean;
  dailyLimitReached: boolean;
  suppressed: boolean;
  accountHealthy: boolean;
  /** Verilmezse kullanıcı filtreleri uygulanmaz (eski politika girdileri). */
  filters?: AutoApplyFilters;
  subject?: FilterSubject;
  now: Date;
  freshnessMinutes?: number;
  /** Kuyruğa alma aşamasında tazelik kontrolü worker'a bırakılır. */
  checkFreshness?: boolean;
}

export interface PolicyDecision {
  eligible: boolean;
  reasons: ReasonCode[];
}

export function evaluatePolicy(i: PolicyInput): PolicyDecision {
  const r: ReasonCode[] = [];
  if (!i.policy.active) r.push('POLICY_INACTIVE');
  if (i.emergencyStop) r.push('EMERGENCY_STOP');
  if (i.intent === 'job_application' && !i.policy.modeJobApplication) r.push('MODE_DISABLED');
  if (i.intent === 'general_intent' && !i.policy.modeGeneralIntent) r.push('MODE_DISABLED');
  if (!i.accountHealthy) r.push('ACCOUNT_UNHEALTHY');

  if (i.intent === 'job_application') {
    if (i.titleMatch === 'excluded') r.push('TITLE_EXCLUDED');
    else if (i.titleMatch === 'none') r.push('TITLE_NOT_MATCHED');
    else if (i.titleMatch === 'adjacent' && !i.policy.includeAdjacent) r.push('ADJACENT_NOT_ALLOWED');
    if (!i.job || i.job.status !== 'open') r.push('JOB_NOT_OPEN');
    if (!i.sourceHealthy) r.push('SOURCE_BLOCKED');
    if (i.job && i.job.channel === 'platform') r.push('CHANNEL_MANUAL_ONLY');
    if (i.checkFreshness !== false && i.job) {
      const limit = (i.freshnessMinutes ?? 10) * 60_000;
      if (!i.job.lastVerifiedAt || i.now.getTime() - i.job.lastVerifiedAt.getTime() > limit) r.push('FRESHNESS_STALE');
    }
    if (i.f === null || i.f < i.policy.fMin) r.push('F_BELOW_THRESHOLD');
    if (i.mandatoryFailed) r.push('MANDATORY_FAILED');
    else if (i.mandatoryUnknown) r.push('MANDATORY_UNKNOWN');
    if (i.location === 'unknown' && i.unknownLocationAction !== 'include') r.push('LOCATION_UNKNOWN');
    if (i.location === 'outside') r.push('LOCATION_OUTSIDE');
  }

  // Eşik 0 ise şart aranmaz; aksi halde bilinmeyen değer eşiği karşılamaz.
  if (i.policy.qMin > 0 && (i.q === null || i.q < i.policy.qMin)) r.push('Q_BELOW_THRESHOLD');
  if (i.policy.coverageMin > 0 && (i.coverage === null || i.coverage < i.policy.coverageMin)) r.push('COVERAGE_BELOW_THRESHOLD');

  if (!i.contact) r.push('CONTACT_MISSING');
  else {
    if (!i.contact.verified || i.contact.kind === 'guessed') r.push('CONTACT_UNVERIFIED');
    if (!i.policy.allowedRecipientKinds.includes(i.contact.kind)) r.push('RECIPIENT_KIND_NOT_ALLOWED');
    if (i.contact.suppressed) r.push('SUPPRESSED');
  }
  if (!i.documentsReady) r.push('DOCUMENT_NOT_READY');
  if (i.alreadyApplied) r.push('ALREADY_APPLIED');
  if (i.companyCooldownActive) r.push('COMPANY_COOLDOWN');
  if (i.dailyLimitReached) r.push('DAILY_LIMIT');
  if (i.suppressed && !r.includes('SUPPRESSED')) r.push('SUPPRESSED');
  if (i.filters && i.subject) r.push(...filterReasons(i.filters, i.subject, i.intent));
  return { eligible: r.length === 0, reasons: r };
}
