import { z } from 'zod';

export const AI_KINDS = ['title_analysis', 'title_expansion', 'cv_facts', 'letter_template', 'letter_company_line', 'company_contacts', 'contact_review', 'company_report', 'company_discovery', 'company_lookup', 'company_sizes', 'job_search', 'job_alert', 'mail_draft', 'mail_translate', 'reply_classification', 'inbound_review', 'inbound_fix', 'follow_up'] as const;
export type AiKind = (typeof AI_KINDS)[number];

export const AI_KIND_LABELS: Record<AiKind, string> = {
  title_analysis: 'Unvan ve görev analizi',
  title_expansion: 'Yakın unvan önerisi',
  cv_facts: 'CV bilgilerini çıkarma',
  letter_template: 'Başvuru yazısı kalıbı',
  letter_company_line: 'Firmaya özel cümleler',
  company_contacts: 'İletişim ve ofis araştırması',
  contact_review: 'Bulunan adresleri doğrulama',
  company_report: 'Firma raporu',
  company_discovery: 'Yeni firma keşfi',
  company_lookup: 'Firma arama ve ekleme',
  company_sizes: 'Çalışan sayısı araştırması',
  job_search: 'İlan araması',
  job_alert: 'İş alarmı mailinden ilan çıkarma',
  mail_draft: 'Mail taslağı',
  mail_translate: 'Mail çevirisi',
  reply_classification: 'Yanıt sınıflama',
  inbound_review: 'Mail dönüşü inceleme',
  inbound_fix: 'Hatalı başvuruyu düzeltme',
  follow_up: 'Takip önerisi',
};

export const titleExpansionOutput = z.object({
  adjacentTitles: z.array(z.string().min(2).max(80)).max(20).default([]),
});

export const cvFactsOutput = z.object({
  headline: z.string().max(120).nullable().optional(),
  experienceYears: z.number().int().min(0).max(60).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  experiences: z
    .array(
      z.object({
        company: z.string().min(1).max(120),
        role: z.string().min(1).max(120),
        period: z.string().max(60).nullable().optional(),
        technologies: z.array(z.string().max(40)).max(15).default([]),
        projects: z.array(z.string().max(120)).max(12).default([]),
      }),
    )
    .max(10)
    .default([]),
  skills: z.array(z.string().max(60)).max(40).default([]),
  education: z.string().max(200).nullable().optional(),
  languages: z.array(z.string().max(40)).max(6).default([]),
});

export const letterTemplateOutput = z.object({
  body: z.string().min(100).max(6000),
});

export const mailTranslateOutput = z.object({
  subject: z.string().min(3).max(300),
  body: z.string().min(50).max(20000),
});

export const letterCompanyLineOutput = z.object({
  opening: z.string().min(20).max(900),
  connection: z.string().min(20).max(900),
});

const EMPLOYEES_TEXT_LIMIT = 60;

/**
 * Çalışan sayısı serbest metindir ("51-200", "350"); domain/company-size.ts ayrıştırır. Yan bilgi olduğu için biçimi
 * bozuk gelirse boş sayılır; asıl çıktının (adresler, firma listesi) reddedilmesine yol açmaz.
 */
const employeesField = z.preprocess((v) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v.slice(0, EMPLOYEES_TEXT_LIMIT) : null), z.string().nullable()).optional();

export const companySizesOutput = z.object({
  sizes: z
    .array(
      z.object({
        ref: z.string().max(12),
        employees: employeesField,
        linkedinUrl: z.string().max(300).nullable().optional(),
        sourceUrl: z.string().max(500).nullable().optional(),
      }),
    )
    .max(40)
    .default([]),
});

export const jobSearchOutput = z.object({
  listings: z
    .array(
      z.object({
        title: z.string().min(2).max(200),
        company: z.string().min(1).max(160),
        companyDomain: z.string().max(200).nullable().optional(),
        careersUrl: z.string().max(500).nullable().optional(),
        location: z.string().max(200).nullable().optional(),
        workMode: z.enum(['onsite', 'hybrid', 'remote', 'unknown']).catch('unknown').default('unknown'),
        url: z.string().min(8).max(600),
        platform: z.string().max(60).nullable().optional(),
        postedAt: z.string().max(40).nullable().optional(),
        applyEmail: z.string().max(200).nullable().optional(),
      }),
    )
    .max(40)
    .default([]),
});

export const jobAlertOutput = z.object({
  listings: z
    .array(
      z.object({
        title: z.string().min(2).max(200),
        company: z.string().min(1).max(160),
        location: z.string().max(200).nullable().optional(),
        workMode: z.enum(['onsite', 'hybrid', 'remote', 'unknown']).catch('unknown').default('unknown'),
        link: z.string().regex(/^L\d{1,3}$/),
      }),
    )
    .max(60)
    .default([]),
});

export const companyContactsOutput = z.object({
  searches: z.array(z.string().max(300)).max(40).optional(),
  website: z.string().max(300).nullable().optional(),
  employees: employeesField,
  group: z
    .object({
      name: z.string().max(200),
      website: z.string().max(300).nullable().optional(),
      hrEmail: z.string().max(200).nullable().optional(),
      sourceUrl: z.string().max(500).nullable().optional(),
    })
    .nullable()
    .optional(),
  contacts: z
    .array(
      z.object({
        email: z.string().max(200),
        name: z.string().max(120).nullable().optional(),
        title: z.string().max(160).nullable().optional(),
        roleType: z.string().max(40).nullable().optional(),
        purpose: z.string().max(40).nullable().optional(),
        origin: z.enum(['published', 'pattern', 'likely']).nullable().optional(),
        sourceUrl: z.string().max(500).nullable().optional(),
        evidence: z.string().max(400).nullable().optional(),
      }),
    )
    .max(25)
    .default([]),
  offices: z
    .array(
      z.object({
        label: z.string().max(120).nullable().optional(),
        city: z.string().max(80).nullable().optional(),
        district: z.string().max(80).nullable().optional(),
        address: z.string().max(300).nullable().optional(),
        sourceUrl: z.string().max(500).nullable().optional(),
      }),
    )
    .max(6)
    .default([]),
});

export const titleAnalysisOutput = z.object({
  match: z.enum(['exact', 'adjacent', 'excluded', 'none']),
  reason: z.string().max(600),
  mandatoryRequirements: z.array(z.string().max(200)).max(15).default([]),
  scopeFit: z.enum(['full', 'partial', 'none', 'unknown']).default('unknown'),
  evidenceIds: z.array(z.string()).default([]),
});

export const contactReviewOutput = z.object({
  reviews: z
    .array(
      z.object({
        ref: z.string().max(20),
        keep: z.boolean(),
        roleType: z.string().max(40).nullable().optional(),
        confidence: z.coerce.number().min(0).max(100),
        reason: z.string().max(300).nullable().optional(),
      }),
    )
    .max(40)
    .default([]),
});

export const companyReportOutput = z.object({
  summary: z.string().max(1500),
  employees: employeesField,
  services: z.array(z.string().max(80)).max(20).default([]),
  evidence: z
    .array(
      z.object({
        dimension: z.enum(['customer', 'campaign', 'reputation', 'service_fit', 'production']),
        customerName: z.string().max(120).nullable().optional(),
        scope: z.enum(['local', 'global', 'unknown']).default('unknown'),
        claimType: z.enum(['logo_wall', 'dated_case', 'independent', 'award', 'team', 'service', 'news', 'other']),
        title: z.string().max(200),
        summary: z.string().max(600).optional(),
        evidenceDate: z.string().max(20).nullable().optional(),
        confidence: z.enum(['low', 'medium', 'high']).default('medium'),
        sourceRef: z.string(),
        url: z.string().max(500).nullable().optional(),
      }),
    )
    .max(30)
    .default([]),
  roleNeedInference: z.object({ text: z.string().max(600), sourceRefs: z.array(z.string()).default([]) }).nullable().optional(),
  applicationAngle: z.string().max(600).nullable().optional(),
  confirmQuestions: z.array(z.string().max(300)).max(5).default([]),
  offices: z
    .array(
      z.object({
        label: z.string().max(120).nullable().optional(),
        city: z.string().max(80).nullable().optional(),
        district: z.string().max(80).nullable().optional(),
        address: z.string().max(300).nullable().optional(),
        sourceUrl: z.string().max(500).nullable().optional(),
      }),
    )
    .max(10)
    .default([]),
  contacts: z
    .array(
      z.object({
        email: z.string().max(200),
        purpose: z.string().max(40).nullable().optional(),
        sourceUrl: z.string().max(500),
      }),
    )
    .max(8)
    .default([]),
});

export const companyDiscoveryOutput = z.object({
  companies: z
    .array(
      z.object({
        name: z.string().min(1).max(160),
        domain: z.string().max(200).nullable().optional(),
        district: z.string().max(80).nullable().optional(),
        sectors: z.array(z.string().max(60)).max(6).default([]),
        reason: z.string().max(400),
        sourceUrl: z.string().max(500),
        signal: z.enum(['open_role', 'sector_fit']).default('sector_fit'),
        careersUrl: z.string().max(500).nullable().optional(),
        atsUrl: z.string().max(500).nullable().optional(),
        openRoles: z.array(z.object({ title: z.string().max(200), url: z.string().max(500).nullable().optional() })).max(10).default([]),
        hrEmail: z.string().max(200).nullable().optional(),
        hrEmailSource: z.string().max(500).nullable().optional(),
        officeAddress: z.string().max(300).nullable().optional(),
        officeCity: z.string().max(80).nullable().optional(),
        officeSource: z.string().max(500).nullable().optional(),
        employees: employeesField,
      }),
    )
    .max(30)
    .default([]),
});

export const mailDraftOutput = z.object({
  subject: z.string().min(3).max(200),
  body: z.string().min(20).max(6000),
  selectedWorkIndexes: z.array(z.number().int().min(0)).max(3).default([]),
  confirmQuestion: z.string().max(300).nullable().optional(),
});

export const replyClassificationOutput = z.object({
  classification: z.enum(['human_reply', 'autoresponder', 'bounce', 'rejection', 'interview', 'do_not_contact', 'unknown']),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300).optional(),
});

export const inboundReviewOutput = z.object({
  category: z.enum(['format_issue', 'apply_elsewhere', 'address_changed', 'auto_reply', 'out_of_office', 'human_reply', 'interview', 'rejection', 'do_not_contact', 'unknown']),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(400).optional().default(''),
  suggestedEmail: z.string().max(200).nullable().optional(),
  suggestedUrl: z.string().max(500).nullable().optional(),
});

export const inboundFixOutput = z.object({
  action: z.enum(['resend', 'research', 'skip']),
  toEmail: z.string().max(200).nullable().optional(),
  subject: z.string().min(3).max(300).nullable().optional(),
  body: z.string().min(20).max(12000).nullable().optional(),
  attachments: z.enum(['all', 'cv_only', 'none']).default('all'),
  reason: z.string().max(600).default(''),
});

export const followUpOutput = z.object({
  subject: z.string().min(3).max(200),
  body: z.string().min(20).max(3000),
});

export const OUTPUT_SCHEMAS: Record<AiKind, z.ZodTypeAny> = {
  title_analysis: titleAnalysisOutput,
  title_expansion: titleExpansionOutput,
  cv_facts: cvFactsOutput,
  letter_template: letterTemplateOutput,
  letter_company_line: letterCompanyLineOutput,
  mail_translate: mailTranslateOutput,
  company_contacts: companyContactsOutput,
  contact_review: contactReviewOutput,
  company_report: companyReportOutput,
  company_discovery: companyDiscoveryOutput,
  company_lookup: companyDiscoveryOutput,
  company_sizes: companySizesOutput,
  job_search: jobSearchOutput,
  job_alert: jobAlertOutput,
  mail_draft: mailDraftOutput,
  reply_classification: replyClassificationOutput,
  inbound_review: inboundReviewOutput,
  inbound_fix: inboundFixOutput,
  follow_up: followUpOutput,
};

/** Model çıktısından JSON nesnesini çıkarır (kod bloğu içinde veya düz metin). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('Yanıtta JSON bulunamadı');
  }
}
