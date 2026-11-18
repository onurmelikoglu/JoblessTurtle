export const BATCH_ITEM_STATES = ['queued', 'running', 'done', 'no_result', 'skipped', 'deferred', 'failed'] as const;
export type BatchItemState = (typeof BATCH_ITEM_STATES)[number];

/** Henüz bitmemiş öğeler: sırada, çalışıyor ya da kota açılmayı bekliyor. */
export const ACTIVE_ITEM_STATES: BatchItemState[] = ['queued', 'running', 'deferred'];

export const STUCK_RUNNING_MS = 2 * 3600_000;
export const MAX_ITEM_ATTEMPTS = 4;

export const FOUND_FIELDS = ['email', 'person', 'office', 'employees', 'phone', 'work_policy', 'linkedin', 'website'] as const;
export type FoundField = (typeof FOUND_FIELDS)[number];

export interface CompanySnapshot {
  sendable: number;
  manual: number;
  offices: number;
  employees: boolean;
  phone: boolean;
  workPolicy: boolean;
  linkedin: boolean;
  website: boolean;
}

/** Araştırmadan önce ve sonra firmanın bilinenleri karşılaştırılır; yeni öğrenilen her alan bir kez sayılır. */
export function fieldsFound(before: CompanySnapshot, after: CompanySnapshot): FoundField[] {
  const gained = (b: boolean, a: boolean) => !b && a;
  const found: [FoundField, boolean][] = [
    ['email', after.sendable > before.sendable],
    ['person', after.manual > before.manual],
    ['office', after.offices > before.offices],
    ['employees', gained(before.employees, after.employees)],
    ['phone', gained(before.phone, after.phone)],
    ['work_policy', gained(before.workPolicy, after.workPolicy)],
    ['linkedin', gained(before.linkedin, after.linkedin)],
    ['website', gained(before.website, after.website)],
  ];
  return found.filter(([, yes]) => yes).map(([field]) => field);
}

export interface ResearchOutcome {
  status: string;
  reason?: string;
}

const RETRY_LATER = ['unavailable', 'awaiting_user', 'deferred'];

/**
 * Araştırma sonucunun öğe durumu. Yapay zekâ o an kullanılamadıysa öğe ertelenir; birkaç denemeden sonra hâlâ
 * kullanılamıyorsa başarısız sayılır, böylece kurulu sağlayıcısı olmayan çalışma alanında öğe sonsuza kadar dönmez.
 */
export function itemStateOf(outcome: ResearchOutcome, found: FoundField[], attempts = 1): { state: BatchItemState; note: string | null } {
  if (outcome.status === 'succeeded') return found.length ? { state: 'done', note: null } : { state: 'no_result', note: 'Yeni bilgi bulunamadı' };
  if (outcome.status === 'skipped') return { state: 'skipped', note: outcome.reason === 'exhausted' ? 'Yakın zamanda derinlemesine arandı' : 'Yakın zamanda arandı' };
  if (RETRY_LATER.includes(outcome.status)) {
    if (attempts >= MAX_ITEM_ATTEMPTS) return { state: 'failed', note: 'Web araması yapabilen yapay zekâ kullanılamadı' };
    return { state: 'deferred', note: outcome.reason === 'no_web_tools' ? 'Web araması yapabilen yapay zekâ şu an kullanılamıyor' : 'Yapay zekâ şu an kullanılamıyor; kota açılınca devam edecek' };
  }
  return { state: 'failed', note: outcome.reason ?? 'Araştırma tamamlanamadı' };
}

export interface BatchProgress {
  total: number;
  finished: number;
  queued: number;
  running: number;
  deferred: number;
  done: number;
  noResult: number;
  skipped: number;
  failed: number;
  found: Record<'email' | 'person' | 'office' | 'employees' | 'phone' | 'workPolicy' | 'linkedin', number>;
  activeCompanyIds: string[];
  deferredNote: string | null;
}

export function batchProgress(items: { companyId: string; state: string; found: string[]; note: string | null }[]): BatchProgress {
  const count = (state: BatchItemState) => items.filter((i) => i.state === state).length;
  const withField = (field: FoundField) => items.filter((i) => i.found.includes(field)).length;
  const active = items.filter((i) => (ACTIVE_ITEM_STATES as string[]).includes(i.state));
  return {
    total: items.length,
    finished: items.length - active.length,
    queued: count('queued'),
    running: count('running'),
    deferred: count('deferred'),
    done: count('done'),
    noResult: count('no_result'),
    skipped: count('skipped'),
    failed: count('failed'),
    found: {
      email: withField('email'),
      person: withField('person'),
      office: withField('office'),
      employees: withField('employees'),
      phone: withField('phone'),
      workPolicy: withField('work_policy'),
      linkedin: withField('linkedin'),
    },
    activeCompanyIds: active.map((i) => i.companyId),
    deferredNote: items.find((i) => i.state === 'deferred')?.note ?? null,
  };
}
