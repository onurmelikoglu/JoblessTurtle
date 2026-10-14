/**
 * Başvuru şablonları — doküman §15. Değişkenler allowlist ile sınırlıdır.
 * İlanı olmayan firmaya "ilanınıza başvuruyorum" gibi cümle üretilemez.
 */

export type IntentType = 'job_application' | 'intent_after_closed' | 'general_intent' | 'project_collab' | 'follow_up';

export const INTENT_LABELS: Record<IntentType, string> = {
  job_application: 'İlan başvurusu',
  intent_after_closed: 'Geçmiş rol sonrası niyet',
  general_intent: 'Genel niyet',
  project_collab: 'Proje iş birliği',
  follow_up: 'Takip',
};

export const ALLOWED_VARIABLES = [
  'company',
  'title',
  'work_example',
  'portfolio_url',
  'signature',
  'candidate_name',
  'headline',
] as const;
export type TemplateVars = Partial<Record<(typeof ALLOWED_VARIABLES)[number], string>>;

const JOB_POSTING_PHRASES = [
  /ilan[ıi]n[ıi]za/i,
  /ilan[ıi]n[ıi]z/i,
  /yay[ıi]nlad[ıi][gğ][ıi]n[ıi]z (pozisyon|ilan)/i,
  /your (job )?(posting|advert|advertisement|opening)/i,
  /advertised (role|position)/i,
];

export const DEFAULT_TEMPLATES: Record<IntentType, { subject: string; body: string }> = {
  job_application: {
    subject: 'İş Başvurusu: {title} – {candidate_name}',
    body:
      'Merhaba {company} Ekibi,\n\n' +
      '{title} pozisyonu için başvurumu iletmek istiyorum. {headline}\n\n' +
      '{work_example}\n\n' +
      "CV'mi ekte paylaşıyorum. Uygun görürseniz görüşmekten memnuniyet duyarım.\n\n" +
      'Saygılarımla,\n{signature}',
  },
  intent_after_closed: {
    subject: 'Açık Başvuru – {candidate_name}',
    body:
      'Merhaba {company} Ekibi,\n\n' +
      'Daha önce {title} rolü için bir arayışınız olduğunu gördüm; bu yeni bir tanışma talebidir. {headline}\n\n' +
      '{work_example}\n\n' +
      "CV'mi ekte paylaşıyorum. Benzer bir ihtiyaç olursa görüşmekten memnuniyet duyarım.\n\n" +
      'Saygılarımla,\n{signature}',
  },
  general_intent: {
    subject: 'Açık Başvuru – {candidate_name}',
    body:
      'Merhaba {company} Ekibi,\n\n' +
      'Şu anda deneyimimle doğrudan örtüşen açık bir pozisyon göremesem de, gelecekte oluşabilecek ihtiyaçlarınız için özgeçmişimi paylaşmak istedim. {headline}\n\n' +
      '{work_example}\n\n' +
      "CV'mi ekte paylaşıyorum. Deneyimimin mevcut veya ileride oluşabilecek bir ihtiyaçla örtüşmesi halinde tanışıp detaylı konuşmaktan memnuniyet duyarım.\n\n" +
      'İyi çalışmalar dilerim.\n\n{signature}',
  },
  project_collab: {
    subject: 'Proje bazlı iş birliği — {candidate_name}',
    body:
      'Merhaba {company} ekibi,\n\n' +
      'Proje bazlı kreatif iş birliği için kendimi tanıtmak istiyorum. {headline}\n\n' +
      '{work_example}\n\n' +
      'Portföyüm: {portfolio_url}\n\n{signature}',
  },
  follow_up: {
    subject: 'Re: {title} başvurum — {candidate_name}',
    body:
      'Merhaba,\n\n' +
      'Birkaç gün önce ilettiğim başvurumla ilgili kısa bir hatırlatma yapmak istedim. Ek bilgi gerekirse memnuniyetle paylaşırım.\n\n' +
      'Teşekkürler,\n{signature}',
  },
};

export function renderTemplate(template: string, vars: TemplateVars): string {
  return template
    .replace(/\{([a-z_]+)\}/g, (_, name: string) => {
      if (!(ALLOWED_VARIABLES as readonly string[]).includes(name)) return '';
      return (vars as Record<string, string | undefined>)[name] ?? '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function unknownVariables(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(/\{([a-z_]+)\}/g)) {
    if (!(ALLOWED_VARIABLES as readonly string[]).includes(m[1])) found.add(m[1]);
  }
  return [...found];
}

export interface DraftCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Taslak içerik kuralları: ilan dışı amaçta ilan ifadesi yok; adayda bulunmayan yıl iddiası yok;
 * metinde uygulamanın belirlemediği e-posta adresi yok.
 */
export function checkDraftContent(input: {
  intent: IntentType;
  subject: string;
  body: string;
  verifiedFactsText: string;
  allowedEmails: string[];
}): DraftCheck {
  const problems: string[] = [];
  const text = `${input.subject}\n${input.body}`;
  if (input.intent !== 'job_application' && input.intent !== 'follow_up') {
    for (const re of JOB_POSTING_PHRASES) {
      if (re.test(text)) {
        problems.push('İlanı olmayan başvuruda ilan ifadesi kullanılamaz');
        break;
      }
    }
  }
  const facts = input.verifiedFactsText.toLowerCase();
  for (const m of text.matchAll(/(\d{1,2})\s*\+?\s*(y[ıi]l|years?)/gi)) {
    if (!facts.includes(m[1])) problems.push(`Doğrulanmamış deneyim iddiası: "${m[0]}"`);
  }
  const allowed = input.allowedEmails.map((e) => e.toLowerCase());
  for (const m of text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
    if (!allowed.includes(m[0].toLowerCase())) problems.push(`Metinde izin verilmeyen e-posta adresi: ${m[0]}`);
  }
  if (!input.subject.trim()) problems.push('Konu boş olamaz');
  if (input.body.trim().length < 20) problems.push('Metin çok kısa');
  return { ok: problems.length === 0, problems };
}

export function buildSignature(c: { signature: string | null; displayName: string; headline?: string | null; phone: string | null; email: string | null }) {
  return c.signature?.trim() || [c.displayName, c.headline, c.phone, c.email].filter(Boolean).join('\n');
}
