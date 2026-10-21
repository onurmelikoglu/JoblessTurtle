import { classifyTitle } from '../../domain/titles';
import { extractSuggestions } from '../../domain/inbound';
import { DEFAULT_TEMPLATES, IntentType, renderTemplate } from '../../domain/templates';
import { AiKind } from './schemas';

/** AI olmadan kural tabanlı çıktı. Hiçbir olgu uydurmaz; yalnızca verilen alanları kullanır. */
export function templateOutput(kind: AiKind, input: any): unknown {
  switch (kind) {
    case 'title_analysis': {
      const r = classifyTitle(input.title, input);
      return { match: r.match, reason: r.term ? `Kural eşleşmesi: ${r.term}${r.note ? ` (${r.note})` : ''}` : 'Kural eşleşmesi yok', mandatoryRequirements: [], scopeFit: 'unknown', evidenceIds: [] };
    }
    case 'company_contacts':
      return { contacts: [], offices: [] };
    case 'contact_review':
      return { reviews: [] };
    case 'letter_template':
      return {
        body: [
          'Merhaba {firma} Ekibi,',
          '{firma_giris}',
          [input.candidate?.headline, input.candidate?.experienceYears ? `Yaklaşık ${input.candidate.experienceYears} yıllık deneyime sahibim.` : null].filter(Boolean).join(' ') || 'Deneyimlerimi kısaca paylaşmak isterim.',
          '{firma_baglanti}',
          "Özgeçmişimi ekte paylaşıyorum. Deneyimimin mevcut veya ileride oluşabilecek bir ihtiyaçla örtüşmesi halinde tanışıp detaylı konuşmaktan memnuniyet duyarım.",
          `İyi çalışmalar dilerim.\n\n${input.signature ?? ''}`.trim(),
        ].join('\n\n'),
      };
    case 'mail_translate':
      return { subject: input.subject, body: input.body };
    case 'letter_company_line':
      return {
        opening: input.jobTitle
          ? `${input.company?.name ?? 'Firma'} ekibinin çalışmalarını ilgiyle takip ediyorum ve ${input.jobTitle} pozisyonu için başvurumu iletmek istiyorum.`
          : `${input.company?.name ?? 'Firma'} ekibinin çalışmalarını ilgiyle takip ediyorum ve uzmanlık alanımla örtüşebilecek ihtiyaçlarınız için açık başvuru olarak değerlendirilmek istiyorum.`,
        connection: 'Deneyimimin ekibinizin çalışmalarına katkı sağlayabileceğini düşünüyorum.',
      };
    case 'cv_facts':
      return { experiences: [], skills: [], languages: [] };
    case 'title_expansion':
      return { adjacentTitles: [] };
    case 'company_report':
      return {
        summary: `${input.company.name} için otomatik analiz yapılmadı (şablon modu). ${input.sources?.length ?? 0} kaynak parçası kaydedildi; kanıtları firma ekranından ekleyebilirsiniz.`,
        services: [],
        evidence: [],
        roleNeedInference: null,
        applicationAngle: null,
        confirmQuestions: ['Firmanın güncel müşteri işleri ve ekip yapısı doğrulanmalı.'],
      };
    case 'company_discovery':
    case 'company_lookup':
      return { companies: [] };
    case 'company_sizes':
      return { sizes: [] };
    case 'job_search':
    case 'job_alert':
      return { listings: [] };
    case 'mail_draft': {
      const t = DEFAULT_TEMPLATES[input.intent as IntentType] ?? DEFAULT_TEMPLATES.general_intent;
      const work = (input.portfolioItems ?? [])[0];
      const vars = {
        company: input.company?.name ?? '',
        title: input.job?.title ?? input.targetTitle ?? '',
        candidate_name: input.candidate?.name ?? '',
        headline: input.candidate?.headline ?? '',
        portfolio_url: input.candidate?.portfolioUrl ?? '',
        signature: input.candidate?.signature ?? input.candidate?.name ?? '',
        work_example: work ? `Örnek bir çalışmam: ${work.title}${work.client ? ` (${work.client}${work.year ? `, ${work.year}` : ''})` : ''}${work.url ? ` — ${work.url}` : ''}.` : '',
      };
      return { subject: renderTemplate(t.subject, vars), body: renderTemplate(t.body, vars), selectedWorkIndexes: work ? [0] : [], confirmQuestion: null };
    }
    case 'reply_classification': {
      const text = `${input.subject ?? ''}\n${input.snippet ?? ''}`.toLowerCase();
      const rules: [RegExp, string, number][] = [
        [/(mailer-daemon|delivery status notification|undeliverable|teslim edilemedi|address not found)/, 'bounce', 0.95],
        [/(iletişime geçmeyin|listeden çıkar|do not contact|unsubscribe|remove me)/, 'do_not_contact', 0.85],
        [/(out of office|otomatik yanıt|auto-?reply|izindeyim|ofis dışında)/, 'autoresponder', 0.9],
        [/(maalesef|olumsuz|uygun bulunmadı|unfortunately|not moving forward|decided to pursue other)/, 'rejection', 0.75],
        [/(görüşme|mülakat|interview|toplantı|meet with you|tanışmak isteriz)/, 'interview', 0.7],
      ];
      for (const [re, cls, conf] of rules) if (re.test(text)) return { classification: cls, confidence: conf, reason: 'Anahtar kelime kuralı' };
      return { classification: 'human_reply', confidence: 0.5, reason: 'Kural eşleşmesi yok' };
    }
    case 'inbound_fix': {
      const candidate = (input.candidates ?? [])[0]?.email ?? null;
      const sameAddressOk = ['too_large', 'mailbox_full', 'rejected'].includes(input.category);
      if (input.category === 'apply_elsewhere') return { action: 'skip', toEmail: null, subject: null, body: null, attachments: 'all', reason: 'Firma yalnızca kariyer sitesinden başvuru kabul ediyor' };
      if (input.suggestedEmail) return { action: 'resend', toEmail: input.suggestedEmail, subject: null, body: null, attachments: 'all', reason: 'Firmanın bildirdiği adrese gönderilecek' };
      if (sameAddressOk) return { action: 'resend', toEmail: input.sentTo, subject: null, body: null, attachments: input.category === 'mailbox_full' ? 'all' : 'cv_only', reason: 'Aynı adrese daha küçük eklerle gönderilecek' };
      if (candidate) return { action: 'resend', toEmail: candidate, subject: null, body: null, attachments: 'all', reason: 'Firmanın diğer adresine gönderilecek' };
      return { action: 'research', toEmail: null, subject: null, body: null, attachments: 'all', reason: 'Yeni adres aranacak' };
    }
    case 'inbound_review': {
      const category = input.ruleCategory ?? 'unknown';
      const found = extractSuggestions(`${input.subject ?? ''}\n${input.text ?? ''}`, [input.sentTo ?? '', input.fromEmail ?? '']);
      return { category, confidence: 0.6, reason: '', suggestedEmail: found.email, suggestedUrl: found.url };
    }
    case 'follow_up': {
      const t = DEFAULT_TEMPLATES.follow_up;
      const vars = { title: input.previousTitle ?? '', candidate_name: input.candidate?.name ?? '', signature: input.candidate?.signature ?? input.candidate?.name ?? '' };
      return { subject: input.previousSubject ? `Re: ${input.previousSubject}` : renderTemplate(t.subject, vars), body: renderTemplate(t.body, vars) };
    }
  }
}
