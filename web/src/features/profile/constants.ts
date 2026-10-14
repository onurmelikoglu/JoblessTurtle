export const DAILY_AI_LIMIT_OPTIONS: readonly number[] = [60, 150, 300, 500, 1000];
export const MAIL_LIMIT_OPTIONS: readonly number[] = [50, 100, 200, 300, 400, 500];
export const INVITEE_LIMIT_OPTIONS: readonly number[] = [20, 60, 150, 300, 500, 1000, 2000, 5000];

export const MIN_PASSWORD_LENGTH = 8;
export const VISIBLE_INVITES = 5;

export const MODEL_PROVIDERS = [
  { name: 'cli_claude', label: 'Claude' },
  { name: 'cli_codex', label: 'ChatGPT' },
] as const;

export const MODEL_KINDS = ['job_search', 'company_discovery', 'company_report', 'company_contacts', 'company_sizes', 'letter_template', 'letter_company_line', 'cv_facts', 'title_expansion', 'mail_draft'] as const;

export const LETTER_SOURCE_LABELS: Record<string, string> = { ai: 'Claude oluşturdu', user: 'Senin düzenlemen', default: 'Varsayılan şablon' };

export const REGENERATE_POLL_MS = 4_000;
export const REGENERATE_TIMEOUT_MS = 4 * 60_000;
export const EXAMPLE_POLL_MS = 5_000;
export const EXAMPLE_TIMEOUT_MS = 6 * 60_000;

export const CANDIDATE_REQUIRED = 'Önce "Bilgilerin" bölümünü kaydet';
