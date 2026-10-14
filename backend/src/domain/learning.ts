/**
 * Deneyim defteri: sistemin yaptığı işin (features) sonucuyla (outcome) birlikte saklanan ham kaydı.
 * Hangi adres türünün ulaştığı, hangi aramanın adres bulduğu gibi sorular ve ileride eğitilecek modeller bu
 * kayıtlardan beslenir.
 */
export const LEARNING_KINDS = ['send', 'contact_search', 'discovery', 'size_search', 'job_search'] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];

export interface SendOutcome {
  /** Son belirleyici mail dönüşü kategorisi; dönüş yoksa "no_bounce" ya da "unobserved". */
  category: string;
  delivered: boolean;
  bounced: boolean;
  replied: boolean;
  dead: boolean;
}

export const NO_BOUNCE_OUTCOME = 'no_bounce';
export const UNOBSERVED_OUTCOME = 'unobserved';
