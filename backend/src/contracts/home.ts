import type { HomeAddressSearch } from './contact-search';
/**
 * Sade arayüzün kullandığı /v1/home uçlarının yanıt sözleşmesi. Sunucu bu tipleri ServerShape ile uygular,
 * web arayüzü aynı dosyayı yalnızca tip olarak içe aktarır; bu yüzden burada çalışma zamanı kodu ve
 * sunucuya özgü bağımlılık bulunmaz.
 */
import type { ActivityKind, ActivityStatus } from '../domain/activity';
import type { AiClass } from '../domain/ai-budget';
import type { ApplyLink } from '../domain/apply-links';
import type { AutopilotMode, AutopilotState, AutopilotStep } from '../domain/autopilot';
import type { CompanyClass } from '../domain/company-class';
import type { EmployeeRange, EmployeeSize } from '../domain/company-size';
import type { WorkScope } from '../domain/geo';
import type { IsoDate } from './wire';

export type { ActivityKind, ActivityStatus, AiClass, ApplyLink, AutopilotMode, AutopilotState, AutopilotStep, CompanyClass, EmployeeRange, EmployeeSize, IsoDate, WorkScope };

export type SetupStep = 'profile' | 'cv' | 'positions' | 'mail';

export interface SetupDocument {
  id: string;
  fileName: string;
  scanState: string;
}

export interface HomeSetup {
  complete: boolean;
  missing: SetupStep[];
  candidate: { id: string; displayName: string; email: string | null; headline: string | null; portfolioUrl: string | null; signature: string | null } | null;
  cv: { id: string; fileName: string; scanState: string; createdAt: IsoDate } | null;
  portfolio: { id: string; fileName: string; scanState: string } | null;
  /** İngilizce sürümler: yazı İngilizceye çevrildiğinde ekler bunlara geçer. */
  english: { cv: SetupDocument | null; portfolio: SetupDocument | null };
  positions: string[];
  adjacentPositions: string[];
  cities: string[];
  allowRemote: boolean;
  /** Yurt dışı kapsamı: Türkiye'den çalışılabilen uzaktan ilanlar ve taşınma gerektiren ilanlar ayrı açılır. */
  abroadRemote: boolean;
  abroadRelocation: boolean;
  abroadRegions: string[];
  searchProfileId: string | null;
  mailAccount: { id: string; provider: string; accountEmail: string; health: string; dailyLimit: number } | null;
}

export interface ActivityItem {
  kind: ActivityKind;
  label: string;
  running: number;
  queued: number;
}

export interface HomeActivity {
  status: ActivityStatus;
  /** Worker son bir dakikada durum bildirmediyse false: arka plan işleri ilerlemiyor demektir. */
  workerOnline: boolean;
  items: ActivityItem[];
  /** Zamanlanmış kaynak taramalarından şu an çalışan veya sırada olan; durumu "çalışıyor" yapmaz. */
  routineCrawls: number;
  sources: number;
  companies: number;
  lastScanAt: IsoDate | null;
  nextScanAt: IsoDate | null;
  lastDiscoveryAt: IsoDate | null;
  nextDiscoveryAt: IsoDate | null;
  nextPrepAt: IsoDate | null;
  backlog: { letters: number; lettersReady: number; waitingForBudget: boolean };
}

/** Yapay zekâ görevlerinin öncelik sınıfı: gün içinde ne kadar kullandığı ve şu an çalışıp çalışamadığı. */
export interface AiClassUsage {
  aiClass: AiClass;
  label: string;
  used: number;
  share: number;
  open: boolean;
  /** daily: günün hakkı bu sınıf için doldu · share: sınıfın payı doldu · subscription: abonelik limitine yaklaşıldı. */
  blockedBy: 'daily' | 'share' | 'subscription' | null;
  opensAt: IsoDate | null;
}

export interface HomeAi {
  automatic: boolean;
  usedToday: number;
  dailyLimit: number;
  limitReached: boolean;
  nearLimit: boolean;
  cooldowns: Record<string, string | undefined>;
  limits: Record<string, unknown>;
  /** Öncelik sırasıyla: etkileşimli, düzeltme, yazı, araştırma, keşif. */
  classes: AiClassUsage[];
}

export interface HomeState {
  setup: HomeSetup;
  autoApply: { policyId: string | null; active: boolean; autoSend: boolean };
  activity: HomeActivity;
  counts: { suggestions: number; applied: number; replied: number };
  aiWaiting: { id: string; kind: string; label: string; createdAt: IsoDate }[];
  ai: HomeAi;
}

export type HomeStateWithPolicy = HomeState & { policyBlocker: string | null };

export interface HomeAnalysis {
  summary: string | null;
  potential: string | null;
  approach: string | null;
}

export interface RecipientSuggestion {
  email: string;
  kind: string;
  groupName: string | null;
  sourceUrl: string | null;
  label: string;
  note: string;
}

export interface HomeDraftSummary {
  id: string;
  status: string;
  revision: number;
  subject: string;
  body: string;
  toEmail: string | null;
  problems: string[];
  /** Yazının dili. */
  language: 'tr' | 'en';
}

export interface HomeOpportunity {
  id: string;
  companyId: string;
  jobId: string | null;
  title: string | null;
  category: string;
  company: string;
  website: string | null;
  careersUrl: string | null;
  location: string | null;
  /** İlanın kapsamı: Türkiye'de (local), uzaktan, yurt dışında ya da konumu bilinmiyor. Firmaya genel başvuruda local. */
  scope: WorkScope;
  /** İlanın çalışma şekli; ilanda yazmıyorsa tahmin (workModeEstimated). Firmaya genel başvuruda null. */
  workMode: 'onsite' | 'hybrid' | 'remote' | null;
  workModeEstimated: boolean;
  /** İlan konumunun düştüğü profil şehir seçimleri (ör. "İstanbul (Avrupa Yakası)"); konum yoksa ya da eşleşmezse boş. */
  regions: string[];
  /** Bölgenin kaynağı: ilanın kendi konumu, (ilan konumu tanınmadığında) firmanın ofisleri ya da hiçbiri. */
  regionSource: 'job' | 'office' | 'none';
  /** Bu firmaya/ilana yazılması gereken dil ve gerekçesi (ör. "İlan metninin dili"). */
  language: 'tr' | 'en';
  languageReason: string;
  /** İl ve ilçeden ayrıntılı iş yeri adresi (mahalle, cadde); ilanda yoksa null. */
  address: string | null;
  applyUrl: string | null;
  formOnly: boolean;
  canEmail: boolean;
  groupSuggestion: RecipientSuggestion | null;
  emailSearchExhausted: boolean;
  /** Firmada bulunan, yalnız elle seçilebilen çalışan / yönetim adresi sayısı. */
  manualRecipients: number;
  fit: 'strong' | 'good' | 'check';
  summary: string;
  analysis: HomeAnalysis | null;
  draft: HomeDraftSummary | null;
  links: ApplyLink[];
  foundAt: IsoDate;
  /** Öğrenilmiş sıralama puanı (yanıt ve ilgi modelleri); modeller henüz etkin değilse null. */
  rank: number | null;
}

export interface HomeOffice {
  id: string;
  label: string | null;
  kind: string;
  city: string | null;
  district: string | null;
  address: string | null;
  inRegion: boolean;
}

export interface HomeCompany {
  id: string;
  name: string;
  website: string | null;
  careersUrl: string | null;
  class: CompanyClass;
  sectors: string[];
  cities: string[];
  /** Çalışan sayısı; henüz öğrenilmediyse null. */
  employees: EmployeeSize | null;
  analysis: HomeAnalysis | null;
  offices: HomeOffice[];
  regionMatch: 'yes' | 'no' | 'unknown';
  /** Firmanın ofislerinin düştüğü profil şehir seçimleri. */
  officeRegions: string[];
  /** Firma için elle seçilen başvuru dili; null = otomatik. */
  languageChoice: 'tr' | 'en' | null;
  /** Firmanın yayımladığı merkez telefonu (araştırmadan). */
  phone: string | null;
  /** Firmanın genel çalışma düzeni; kaynakta açıkça yazıyorsa. */
  workPolicy: 'remote' | 'hybrid' | 'onsite' | null;
  opportunities: HomeOpportunity[];
  matchingJobs: number;
  researching: boolean;
  links: ApplyLink[];
  /** Son adres araması; hiç aranmadıysa null. */
  addressSearch: HomeAddressSearch | null;
  foundAt: IsoDate;
}

export interface HomeCompanies {
  companies: HomeCompany[];
  /** Bölge filtresinin çipleri: profildeki şehir seçimleri sırasıyla (yaka seçiliyse "yaka belirsiz" dahil). */
  regionFilters: string[];
  /** truncated: fırsat sayısı liste sınırını aştı; en düşük sıradaki fırsatlar ve yalnız onlara sahip firmalar listede yok. */
  totals: { companies: number; applied: number; matchingJobs: number; byClass: Record<CompanyClass, number>; sizeUnknown: number; truncated: boolean };
}

/** Toplu firma araştırmasının ilerlemesi; sürmekte olan ya da son bir saatte biten iş. */
export interface ResearchBatchStatus {
  id: string;
  status: 'running' | 'done' | 'cancelled';
  startedAt: IsoDate;
  finishedAt: IsoDate | null;
  total: number;
  finished: number;
  queued: number;
  running: number;
  deferred: number;
  done: number;
  noResult: number;
  skipped: number;
  failed: number;
  found: { email: number; person: number; office: number; employees: number; phone: number; workPolicy: number; linkedin: number };
  activeCompanyIds: string[];
  /** Ertelenen öğelerin nedeni (ör. günlük kota doldu). */
  deferredNote: string | null;
}

export interface ResearchBatchStart {
  /** Yeni iş açılmadıysa (firmaların hepsi zaten araştırılıyorsa) null. */
  batchId: string | null;
  queued: number;
  alreadyQueued: number;
  companyIds: string[];
}

export type StatsRange = '30d' | '90d' | 'all';

/** Kişisel istatistikler; hesaplamalar domain/stats.ts. */
export interface StatsOverview {
  range: StatsRange;
  funnel: { key: 'sent' | 'delivered' | 'replied' | 'interview' | 'offer'; label: string; count: number }[];
  rates: { title: string; rows: { key: string; label: string; sent: number; replied: number; rate: number }[] }[];
  weekly: { week: string; sent: number; failed: number; replied: number }[];
  sendTime: {
    grid: { weekday: number; hour: number; sent: number; replied: number }[];
    suggestion: { weekday: number; fromHour: number; toHour: number; rate: number; sent: number } | null;
    /** Öneri için gereken ve şu ana kadar biriken yanıt sayısı. */
    repliesNeeded: number;
    replies: number;
  };
  ai: { tasks: number; costUsd: number };
}

/** Aynı firmanın olası iki kaydı. certain: kanıtlı, kısa süre içinde kendiliğinden birleştirilir. */
export interface CompanyTwin {
  a: { id: string; name: string };
  b: { id: string; name: string };
  level: 'certain' | 'likely';
  reasons: string[];
}

export interface SizeSearchResult {
  /** Araştırma sırasına alınan firma sayısı. */
  queued: number;
  /** Bu turda sıraya sığmayan, çalışan sayısı hâlâ bilinmeyen firma sayısı. */
  remaining: number;
}

export interface SendQueueSummary {
  total: number;
  sent: number;
  remaining: number;
  deferredToTomorrow: number;
  estimatedFinishAt: string;
  dailyLimit: number | null;
  usedToday: number;
}

export interface DeliveryInfo {
  category: string;
  label: string;
  group: string;
  status: string;
}

export interface HomeApplication {
  id: string;
  companyId: string;
  company: string;
  title: string | null;
  formUrl: string | null;
  state: string;
  stateReason: string | null;
  reasonLabel: string | null;
  scheduledAt: IsoDate | null;
  outcome: string | null;
  viaForm: boolean;
  toEmail: string | null;
  sentAt: IsoDate;
  replyCount: number;
  delivery: DeliveryInfo | null;
  retryOfId: string | null;
  retried: boolean;
  links: ApplyLink[];
  /** Süreçteki en son aşama (domain/pipeline.ts); henüz yoksa null. */
  stage: string | null;
  /** Sıradaki planlanmış ya da önerilen mülâkat. */
  nextInterviewAt: IsoDate | null;
  /** 21 gün yanıt gelmedi ve sonuç girilmedi: "yanıt yok" olarak işaretlemek önerilir. */
  ghosted: boolean;
}

export interface InterviewItem {
  id: string;
  attemptId: string;
  company: string;
  title: string | null;
  startsAt: IsoDate;
  durationMin: number;
  kind: 'phone' | 'video' | 'onsite';
  link: string | null;
  location: string | null;
  notes: string | null;
  /** proposed: mailden çıkarıldı, onay bekliyor. */
  status: 'proposed' | 'scheduled' | 'done' | 'cancelled';
  source: 'manual' | 'inbox';
}

export interface StageItem {
  id: string;
  stage: string;
  label: string;
  at: IsoDate;
  note: string | null;
  source: 'manual' | 'inbox';
}

export interface HomeApplications {
  queue: SendQueueSummary | null;
  /** Gizlenmemiş başvuruların toplamı; liste en yeni ilk binle sınırlıdır. */
  total: number;
  items: HomeApplication[];
}

export type FollowUpState = 'pending' | 'drafted' | 'sent' | 'cancelled';

export interface FollowUpItem {
  id: string;
  attemptId: string;
  company: string;
  title: string | null;
  toEmail: string | null;
  sentAt: IsoDate | null;
  dueAt: IsoDate;
  state: FollowUpState;
  draft: { id: string; revision: number; status: string; subject: string; body: string; toEmail: string | null; problems: string[]; language: 'tr' | 'en' } | null;
  /** İptal nedeni ya da son hata. */
  note: string | null;
}

export interface FollowUpList {
  items: FollowUpItem[];
  /** hasPolicy: otomatik başvuru ayarı yoksa takip ayarları değiştirilemez (varsayılan 7 iş günü, elle). */
  settings: { delayDays: number; auto: boolean; hasPolicy: boolean };
}

export interface HomeDocument {
  id: string;
  label: string;
  fileName: string;
  type: string;
  mime: string;
  size: number;
  /** tr | en */
  language: string;
  /** original | ats_main | ats_job (yalnızca CV'lerde anlamlı). */
  variant?: string;
}

export interface HomeApplicationDetail {
  id: string;
  company: string;
  title: string | null;
  state: string;
  stateLabel: string;
  outcome: string | null;
  viaForm: boolean;
  sentAt: IsoDate;
  fromEmail: string | null;
  toEmail: string | null;
  subject: string | null;
  body: string | null;
  links: string[];
  documents: HomeDocument[];
  currentDocuments: HomeDocument[];
  replies: { id: string; fromEmail: string | null; subject: string | null; snippet: string | null; classification: string; receivedAt: IsoDate }[];
  stages: StageItem[];
  interviews: InterviewItem[];
}

export interface RecipientOption {
  email: string;
  kind: string;
  sourceUrl: string | null;
  verified: boolean;
  /** Bu adrese daha önce gönderilen bir başvurunun ulaştığı görüldü (herhangi bir kullanıcıda). */
  delivered: boolean;
  label: string;
  /** Çalışan, yönetim ya da tahmini adres: otomatik gönderimde kullanılmaz, yalnız elle seçilir. */
  manualOnly: boolean;
  /** Adres araştırmasının verdiği 0–100 güven; araştırmadan gelmeyen adreste null. */
  score: number | null;
  /** Kişisel adreste kişinin adı ve unvanı. */
  person: string | null;
}

export interface HomePreviewDraft {
  id: string;
  status: string;
  revision: number;
  fromEmail: string | null;
  toEmail: string | null;
  subject: string;
  body: string;
  links: string[];
  documents: (HomeDocument & { createdAt: IsoDate })[];
  availableDocuments: (HomeDocument & { createdAt: IsoDate })[];
  problems: string[];
  language: 'tr' | 'en';
  ats: HomeAtsOverview;
}

export type HomeAtsStatus = 'ready' | 'preparing' | 'no_job' | 'no_description' | 'no_cv' | 'unavailable';

/** Taslağın dilindeki CV sürümlerinin ilana ATS uyumu. */
export interface HomeAtsOverview {
  status: HomeAtsStatus;
  /** Bu oranın altındaki CV düşük sayılır (yüzde). */
  threshold: number;
  items: HomeAtsItem[];
  best: { documentId: string; score: number } | null;
  attachedScore: number | null;
}

export interface HomeAtsItem {
  documentId: string;
  variant: string;
  label: string;
  score: number;
  /** İlanda istenip CV'de bulunmayan terimler. */
  missing: string[];
  /** İyileştirmede CV'de kanıtı olmadan eklenen beceriler. */
  addedSkills: string[];
  attached: boolean;
}

export interface HomePreview {
  opportunityId: string;
  companyId: string;
  company: string;
  title: string | null;
  applyUrl: string | null;
  suggestedTo: string | null;
  recipientOptions: RecipientOption[];
  groupSuggestion: RecipientSuggestion | null;
  recipientSuggestions: RecipientSuggestion[];
  /** Firmaya/ilana göre önerilen yazı dili ve gerekçesi. */
  language: 'tr' | 'en';
  languageReason: string;
  status: 'preparing' | 'ready' | 'sent';
  draft: HomePreviewDraft | null;
}

export interface HomeLetters {
  placeholders: string[];
  example: string | null;
  templates: { intent: string; label: string; body: string | null; source: 'ai' | 'user' | 'default' | null; updatedAt: string | null }[];
}

export interface InboxAlternative {
  email: string;
  source: 'contact' | 'reply';
}

export interface InboxItem {
  id: string;
  attemptId: string | null;
  companyId: string | null;
  company: string;
  toEmail: string | null;
  sentAt: IsoDate | null;
  fromEmail: string | null;
  subject: string | null;
  snippet: string | null;
  category: string;
  label: string;
  group: string;
  hint: string | null;
  reason: string | null;
  suggestedEmail: string | null;
  suggestedUrl: string | null;
  status: string;
  receivedAt: IsoDate;
  canResend: boolean;
  alternatives: InboxAlternative[];
  retry: { id: string; state: string; toEmail: string | null } | null;
}

/** Otopilotun bir mail dönüşü için verdiği karar: onay bekleyen öneri ya da yapılmış işin kaydı. */
export interface AutopilotActionItem {
  id: string;
  messageId: string;
  attemptId: string;
  companyId: string;
  company: string;
  category: string;
  label: string;
  step: AutopilotStep;
  state: AutopilotState;
  /** Kullanıcının onayıyla uygulandı (false: otopilot kendiliğinden uyguladı ya da henüz uygulanmadı). */
  approved: boolean;
  toEmail: string | null;
  detail: string;
  /** Bu karar için harcanan yapay zekâ görevi. */
  aiTasks: number;
  /** Öneri onaylanırsa yapay zekâ kullanılacak (yazıyı düzeltme, maili yorumlama ya da yeni adres arama). */
  usesAi: boolean;
  retry: { id: string; state: string; scheduledAt: IsoDate | null } | null;
  createdAt: IsoDate;
  executedAt: IsoDate | null;
}

/** Zincirin aşamalarındaki firma ve başvuru sayıları. */
export interface PipelineCounts {
  companies: number;
  withAddress: number;
  /** Adresi arandı ve bulunamadı; yalnızca diğer başvuru kanalları kullanılabilir. */
  noAddress: number;
  lettersReady: number;
  queued: number;
  sent: number;
  delivered: number;
  bounced: number;
  replied: number;
}

export interface AutopilotOverview {
  mode: AutopilotMode;
  pending: number;
  actions: AutopilotActionItem[];
  pipeline: PipelineCounts;
}

/** İş sitelerinden gelen ilan bildirimlerinin (iş alarmı) özeti. */
export interface JobAlertStats {
  /** İşlenen bildirim postası sayısı. */
  mails: number;
  /** Bu postalardan listeye eklenen yeni ilan sayısı. */
  listings: number;
  lastAt: IsoDate | null;
  platforms: string[];
  /** Site başına alınan alarm postası; alarmın çalıştığını gösterir. */
  sites: JobAlertSite[];
  /** Alarm kurulumunda seçilebilecek pozisyonlar: etkin profillerin tam unvanları. */
  titles: string[];
  /** Alarm kurulumunun başlangıç şehir seçimi (profilden); kullanıcı istediği şehri ekleyip çıkarabilir. */
  cities: string[];
}

export interface JobAlertSite {
  platform: string;
  mails: number;
  lastAt: IsoDate | null;
}


export interface HomeInbox {
  alerts: JobAlertStats;
  accounts: { id: string; email: string; supported: boolean; enabled: boolean; syncedAt: IsoDate | null; error: string | null; running: boolean }[];
  counts: { open: number; failed: number; action: number; reply: number; review: number; delivered: number };
  items: InboxItem[];
}

export type HomeInboxWithAutopilot = HomeInbox & { autopilot: AutopilotOverview };

export interface InboxDetail {
  id: string;
  fromEmail: string | null;
  subject: string | null;
  body: string;
  receivedAt: IsoDate;
  reason: string | null;
}

/** Kayıtlı bir firmaya benzeyen yeni firmanın kullanıcı kararına bekletilen ilanları. */
export interface CompanyDecisionView {
  id: string;
  /** İlan sitesinde görünen yeni ad. */
  name: string;
  domain: string | null;
  reasons: string[];
  listingCount: number;
  titles: string[];
  createdAt: IsoDate;
  suggested: { id: string; name: string; website: string | null; openJobs: number; applications: number };
}

export interface SimilarCompanyView {
  match: { id: string; name: string; level: 'certain' | 'likely'; reasons: string[] } | null;
}

export type CvLayoutState = 'ready' | 'preparing' | 'failed' | 'none' | 'unsupported';

/** Orijinal CV'nin tasarım şablonu: iyileştirilen CV bu görünümle PDF'e çevrilir. */
export interface HomeCvLayout {
  documentId: string;
  fileName: string;
  language: string;
  state: CvLayoutState;
  usesPhoto: boolean;
  reason: string | null;
  createdAt: IsoDate | null;
}

/** Profilde listelenen ATS CV sürümü. */
export interface HomeAtsDocument {
  id: string;
  label: string;
  fileName: string;
  language: string;
  variant: 'ats_main' | 'ats_job' | string;
  /** İlana özel sürümün ilanı ("Firma — Unvan"). */
  job: string | null;
  pendingPromotion: boolean;
  addedSkills: string[];
  size: number;
  createdAt: IsoDate;
}
