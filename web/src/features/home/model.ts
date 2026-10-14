import type { CompanyClass, EmployeeRange, EmployeeSize, HomeAi, HomeApplication, HomeOpportunity, InboxItem } from '@/api/types';
import { fmtTime } from '@/lib/format';
import { aiThrottleNotice } from './autopilot-model';
import type { Tone } from '@/ui/tones';

export const HOME_TABS = ['firmalar', 'basvurular', 'donusler'] as const;
export type HomeTab = (typeof HOME_TABS)[number];

export const COMPANY_CLASS_ORDER: CompanyClass[] = ['open', 'past', 'potential'];

export const CLASS_INFO: Record<CompanyClass, { title: string; short: string; hint: string; tone: Tone }> = {
  open: { title: 'Açık ilanı olan firmalar', short: 'Açık ilan', hint: 'Aradığın ya da yakın bir pozisyonda ilanı olan firmalar.', tone: 'good' },
  past: { title: 'Bu pozisyonu daha önce açmış firmalar', short: 'Geçmişte açmış', hint: 'İlgili ilan kapanmış; firma aynı rolü yeniden açabilir.', tone: 'info' },
  potential: { title: 'Pozisyon açma potansiyeli olan firmalar', short: 'Potansiyel', hint: 'İlgili ilan görülmedi; açık başvuru için uygun firmalar.', tone: 'neutral' },
};

export const CATEGORY_INFO: Record<string, { tag: string; tone: Tone }> = {
  target_open: { tag: 'Açık ilan', tone: 'good' },
  adjacent_open: { tag: 'Yakın rol', tone: 'info' },
  needs_confirmation: { tag: 'Açıklığı teyit edilmeli', tone: 'warn' },
  user_selected: { tag: 'Senin seçimin', tone: 'info' },
  past_closed: { tag: 'Kapanmış ilan', tone: 'neutral' },
  sector_target: { tag: 'Açık başvuru', tone: 'neutral' },
  not_found: { tag: 'Açık başvuru', tone: 'neutral' },
};

const EMPLOYEE_RANGE_TEXT: Record<EmployeeRange, string> = {
  '1-10': '1-10',
  '11-50': '11-50',
  '51-200': '51-200',
  '201-500': '201-500',
  '501-1000': '501-1.000',
  '1001-5000': '1.001-5.000',
  '5001+': '5.000+',
};

export const employeesLabel = (employees: EmployeeSize) => `${EMPLOYEE_RANGE_TEXT[employees.range]} çalışan`;
export const employeesHint = (employees: EmployeeSize) => (employees.count ? `Yaklaşık ${employees.count.toLocaleString('tr-TR')} çalışan` : 'Yaklaşık çalışan sayısı aralığı');

export const hasEmail = (opportunity: Pick<HomeOpportunity, 'canEmail'>) => opportunity.canEmail;
export const draftReady = (opportunity: Pick<HomeOpportunity, 'draft'>) => opportunity.draft !== null && opportunity.draft.problems.length === 0;

export type DeliveryBucket = 'reply' | 'delivered' | 'sent' | 'form' | 'failed' | 'redirect' | 'resent' | 'queued' | 'notSent';

export const BUCKET_ORDER: DeliveryBucket[] = ['reply', 'delivered', 'sent', 'form', 'failed', 'redirect', 'resent', 'queued', 'notSent'];
export const SUCCESSFUL_BUCKETS: ReadonlySet<DeliveryBucket> = new Set(['reply', 'delivered', 'sent', 'form']);
const UNCOUNTED_BUCKETS: ReadonlySet<DeliveryBucket> = new Set(['resent', 'queued']);

export const BUCKET_INFO: Record<DeliveryBucket, { label: string; tone: Tone; hint: string }> = {
  reply: { label: 'Yanıt geldi', tone: 'good', hint: 'Firmadan bir çalışan yanıt verdi (görüşme, ret veya bilgi).' },
  delivered: { label: 'Ulaştı (otomatik yanıt)', tone: 'good', hint: 'Firmanın sistemi mailin alındığını bildirdi.' },
  sent: { label: 'Gönderildi, hata dönmedi', tone: 'info', hint: 'Geri dönme bildirimi gelmedi; büyük ihtimalle yerine ulaştı.' },
  form: { label: 'Formla başvuruldu', tone: 'info', hint: 'Firmanın kendi formundan ya da başka bir kanaldan başvurdun.' },
  failed: { label: 'İletilemedi', tone: 'bad', hint: 'Adres yok, kapalı, ek çok büyük veya sunucu reddetti. Düzenleyip tekrar gönderebilirsin.' },
  redirect: { label: 'Başka kanal istendi', tone: 'warn', hint: 'Ulaştı ama firma kariyer sitesinden ya da başka adresten başvuru istedi.' },
  resent: { label: 'Tekrar gönderildi', tone: 'neutral', hint: 'Hatalı gittiği için düzeltilip yeniden gönderildi; yeni gönderim ayrıca listede.' },
  queued: { label: 'Sırada', tone: 'warn', hint: 'Gönderim kuyruğunda bekliyor.' },
  notSent: { label: 'Gönderilemedi', tone: 'bad', hint: 'Gönderim engellendi veya iptal edildi.' },
};

export function bucketOf(a: Pick<HomeApplication, 'viaForm' | 'retried' | 'state' | 'delivery'>): DeliveryBucket {
  if (a.viaForm) return 'form';
  if (a.retried) return 'resent';
  if (a.state === 'queued' || a.state === 'sending') return 'queued';
  if (a.state === 'blocked' || a.state === 'failed_confirmed' || a.state === 'cancelled') return 'notSent';
  switch (a.delivery?.group) {
    case 'failed':
      return 'failed';
    case 'action':
      return 'redirect';
    case 'reply':
      return 'reply';
    case 'delivered':
      return 'delivered';
    default:
      if (a.state === 'bounced') return 'failed';
      return a.state === 'replied' || a.state === 'outcome_recorded' ? 'reply' : 'sent';
  }
}

export function bucketCounts(applications: HomeApplication[]) {
  const counts = Object.fromEntries(BUCKET_ORDER.map((bucket) => [bucket, 0])) as Record<DeliveryBucket, number>;
  for (const application of applications) counts[bucketOf(application)]++;
  const successful = BUCKET_ORDER.filter((b) => SUCCESSFUL_BUCKETS.has(b)).reduce((n, b) => n + counts[b], 0);
  const counted = BUCKET_ORDER.filter((b) => !UNCOUNTED_BUCKETS.has(b)).reduce((n, b) => n + counts[b], 0);
  return { counts, successful, counted };
}

export const RESENDABLE_STATES: ReadonlySet<string> = new Set(['provider_accepted', 'submission_unknown', 'replied', 'bounced', 'outcome_recorded']);
export const DEAD_ADDRESS_CATEGORIES: ReadonlySet<string> = new Set(['bad_address', 'bad_domain', 'closed_address', 'address_changed']);

const INBOX_TODO_GROUPS: ReadonlySet<string> = new Set(['failed', 'action', 'review']);
export const INBOX_GROUP_TONE: Record<string, Tone> = { failed: 'bad', action: 'warn', review: 'warn', pending: 'neutral', delivered: 'info', reply: 'good' };

export const isInboxTodo = (item: Pick<InboxItem, 'status' | 'group'>) => item.status === 'open' && INBOX_TODO_GROUPS.has(item.group);

/** AI sağlayıcılarının durumu hakkında, yalnızca kullanıcının bilmesi gereken bir şey varsa kısa bir not. */
export function aiNotice(ai: HomeAi): string | null {
  const claude = ai.cooldowns.cli_claude;
  const codex = ai.cooldowns.cli_codex;
  const usage = `${ai.usedToday}/${ai.dailyLimit}`;
  if (claude && codex) return `Claude ve ChatGPT kullanım limitleri doldu; AI işleri ${fmtTime(claude > codex ? codex : claude)} sonrasına kadar bekleyecek.`;
  if (claude) return `Claude kullanım limiti doldu ya da dolmak üzere; ${fmtTime(claude)}'e kadar ChatGPT ile devam ediliyor.`;
  if (ai.limitReached) return `Bugünkü AI işlem hakkın doldu (${usage}). Hazırlık yarın kendiliğinden sürecek.`;
  if (ai.nearLimit) return `Günlük AI işlem hakkının çoğu kullanıldı (${usage}).`;
  return aiThrottleNotice(ai.classes);
}
