/**
 * Arka plan işlerinin kullanıcıya gösterilen özeti. Durum, birikmiş işe değil gerçekten çalışan ve
 * kuyrukta bekleyen işe bakar; zamanlanmış kaynak taraması ("rutin") ayrı sayılır ve durumu değiştirmez.
 */
export const ACTIVITY_KINDS = ['discovery', 'research', 'contacts', 'letters', 'crawl', 'send', 'inbox'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ROUTINE_CRAWL = 'routine' as const;
export type ActivityBucket = ActivityKind | typeof ROUTINE_CRAWL;

export const ACTIVITY_STATUSES = ['working', 'idle', 'paused', 'waiting_ai'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  discovery: 'Firma ve ilan keşfi',
  research: 'Firma analizi',
  contacts: 'Mail adresi araması',
  letters: 'Yazı hazırlama',
  crawl: 'Kariyer sayfası taraması',
  send: 'Mail gönderimi',
  inbox: 'Mail dönüşü kontrolü',
};

/** Gönderim ve gelen kutusu kendi panellerinde izlenir; ana durumu "çalışıyor" yapmaz. */
const FOREGROUND_KINDS: ActivityKind[] = ['discovery', 'research', 'contacts', 'letters', 'crawl'];

const AI_KIND_ACTIVITY: Record<string, ActivityKind> = {
  company_discovery: 'discovery',
  job_search: 'discovery',
  company_lookup: 'discovery',
  title_expansion: 'discovery',
  company_report: 'research',
  company_sizes: 'research',
  title_analysis: 'research',
  company_contacts: 'contacts',
  contact_review: 'contacts',
  letter_template: 'letters',
  letter_company_line: 'letters',
  mail_draft: 'letters',
  mail_translate: 'letters',
  cv_facts: 'letters',
  follow_up: 'letters',
  inbound_review: 'inbox',
  job_alert: 'inbox',
  inbound_fix: 'inbox',
  reply_classification: 'inbox',
};

const QUEUE_JOB_ACTIVITY: Record<string, ActivityKind> = {
  'research:company': 'research',
  'research:company_details': 'contacts',
  'research:company_sizes': 'research',
  'research:job_search': 'discovery',
  'research:catalog_seed': 'discovery',
  'research:letter_template': 'letters',
  'research:predraft': 'letters',
  'research:cv_facts': 'letters',
  'research:expand_titles': 'discovery',
  'research:discovery': 'discovery',
  'interactive:home.prepare': 'letters',
  'interactive:letter_template': 'letters',
  'interactive:draft_translate': 'letters',
  'interactive:company_details': 'contacts',
  'interactive:company_lookup': 'discovery',
  'automation:home.prepare': 'letters',
  'automation:home.apply': 'send',
  'send:attempt': 'send',
  'inbox:sync': 'inbox',
  'inbox:autopilot': 'inbox',
  'inbox:autopilot_run': 'inbox',
};

const OUTBOX_EVENT_ACTIVITY: Record<string, ActivityKind> = {
  'discovery.ai': 'discovery',
  'profile.expand_titles': 'discovery',
  'company.lookup': 'discovery',
  'research.company': 'research',
  'research.sizes': 'research',
  'jobs.search': 'discovery',
  'catalog.seed': 'discovery',
  'research.details': 'contacts',
  'research.details.bulk': 'contacts',
  'research.details.bg': 'contacts',
  'home.prepare': 'letters',
  'letters.generate': 'letters',
  'draft.translate': 'letters',
  'candidate.cv_uploaded': 'letters',
  'collect.all': 'crawl',
  'collect.source': 'crawl',
  'home.apply': 'send',
  'inbox.sync': 'inbox',
  'autopilot.inbound': 'inbox',
  'autopilot.run': 'inbox',
};

export function activityOfAiKind(kind: string): ActivityKind | null {
  return AI_KIND_ACTIVITY[kind] ?? null;
}

export function activityOfOutboxEvent(eventType: string): ActivityKind | null {
  return OUTBOX_EVENT_ACTIVITY[eventType] ?? null;
}

export function activityOfQueueJob(queue: string, name: string, data: { trigger?: unknown } = {}): ActivityBucket | null {
  if (queue === 'collect') return data.trigger === 'manual' ? 'crawl' : ROUTINE_CRAWL;
  return QUEUE_JOB_ACTIVITY[`${queue}:${name}`] ?? null;
}

export type ActivityCounts = Partial<Record<ActivityBucket, { running: number; queued: number }>>;

/** Aynı iş hem kuyrukta "aktif" hem veritabanında "çalışıyor" görünebilir; çalışan sayısında büyük olan alınır, bekleyenler toplanır. */
export function mergeActivity(snapshot: ActivityCounts, live: ActivityCounts): ActivityCounts {
  const out: ActivityCounts = {};
  for (const bucket of [...ACTIVITY_KINDS, ROUTINE_CRAWL] as ActivityBucket[]) {
    const running = Math.max(snapshot[bucket]?.running ?? 0, live[bucket]?.running ?? 0);
    const queued = (snapshot[bucket]?.queued ?? 0) + (live[bucket]?.queued ?? 0);
    if (running + queued > 0) out[bucket] = { running, queued };
  }
  return out;
}

export function activityItems(counts: ActivityCounts) {
  return ACTIVITY_KINDS.filter((kind) => counts[kind]).map((kind) => ({ kind, label: ACTIVITY_LABELS[kind], running: counts[kind]!.running, queued: counts[kind]!.queued }));
}

export function activityStatus(input: { paused: boolean; counts: ActivityCounts; backlogLetters: number; aiBlocked: boolean }): ActivityStatus {
  if (input.paused) return 'paused';
  if (FOREGROUND_KINDS.some((kind) => input.counts[kind])) return 'working';
  if (input.backlogLetters > 0 && input.aiBlocked) return 'waiting_ai';
  return 'idle';
}
