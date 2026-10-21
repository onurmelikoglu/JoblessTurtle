import { checkDraftContent, IntentType } from '../../domain/templates';
import { AiKind, OUTPUT_SCHEMAS } from './schemas';

export interface ValidationContext {
  sourceIds?: string[];
  allowWebRefs?: boolean;
  intent?: IntentType;
  verifiedFactsText?: string;
  allowedEmails?: string[];
  portfolioCount?: number;
}

export interface ValidationResult {
  ok: boolean;
  output?: any;
  problems: string[];
  dropped: number;
}

const REPAIRABLE_KINDS: AiKind[] = ['company_report', 'company_discovery', 'company_contacts', 'contact_review', 'company_sizes', 'job_search', 'job_alert', 'title_analysis', 'title_expansion', 'cv_facts'];
const MAX_REPAIR_PASSES = 5;

function nodeAt(root: unknown, path: (string | number)[]): any {
  return path.reduce<any>((node, key) => node?.[key], root);
}

function repairInformationalOutput(kind: AiKind, raw: unknown) {
  let parsed = OUTPUT_SCHEMAS[kind].safeParse(raw);
  if (parsed.success || !REPAIRABLE_KINDS.includes(kind) || raw === null || typeof raw !== 'object') return parsed;
  const value = structuredClone(raw);
  for (let pass = 0; pass < MAX_REPAIR_PASSES && !parsed.success; pass++) {
    const invalidItems = new Map<unknown[], Set<number>>();
    let repaired = false;
    for (const issue of parsed.error.issues) {
      const parent = nodeAt(value, issue.path.slice(0, -1));
      const key = issue.path[issue.path.length - 1];
      const current = parent?.[key];
      if (issue.code === 'too_big' && (typeof current === 'string' || Array.isArray(current))) {
        parent[key] = current.slice(0, Number(issue.maximum));
        repaired = true;
        continue;
      }
      const itemDepth = issue.path.map((k) => typeof k === 'number').lastIndexOf(true);
      if (itemDepth < 0) continue;
      const list = nodeAt(value, issue.path.slice(0, itemDepth));
      if (!Array.isArray(list)) continue;
      const indexes = invalidItems.get(list) ?? new Set<number>();
      indexes.add(issue.path[itemDepth] as number);
      invalidItems.set(list, indexes);
    }
    for (const [list, indexes] of invalidItems) {
      for (const i of [...indexes].sort((a, b) => b - a)) list.splice(i, 1);
      repaired = true;
    }
    if (!repaired) break;
    parsed = OUTPUT_SCHEMAS[kind].safeParse(value);
  }
  return parsed;
}

/**
 * Model çıktısı JSON şemasıyla ve source_ref listesiyle doğrulanır. Kaynaksız kanıt düşürülür;
 * taslakta uydurma iddia veya yabancı adres varsa çıktı reddedilir.
 */
export function validateAiOutput(kind: AiKind, raw: unknown, ctx: ValidationContext = {}): ValidationResult {
  const parsed = repairInformationalOutput(kind, raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.')}: ${i.message}`), dropped: 0 };
  }
  const out: any = parsed.data;
  const problems: string[] = [];
  let dropped = 0;
  const ids = new Set(ctx.sourceIds ?? []);
  const refOk = (ref: string, url?: string | null) => ids.has(ref) || (!!ctx.allowWebRefs && /^W\d+$/.test(ref) && !!url && /^https?:\/\//.test(url));

  if (kind === 'company_report') {
    const before = out.evidence.length;
    out.evidence = out.evidence.filter((e: any) => refOk(e.sourceRef, e.url));
    dropped = before - out.evidence.length;
    if (out.roleNeedInference) {
      out.roleNeedInference.sourceRefs = out.roleNeedInference.sourceRefs.filter((r: string) => ids.has(r) || (ctx.allowWebRefs && /^W\d+$/.test(r)));
      if (out.roleNeedInference.sourceRefs.length === 0) out.roleNeedInference = null;
    }
  }
  if (kind === 'company_discovery') {
    const before = out.companies.length;
    out.companies = out.companies.filter((c: any) => /^https?:\/\//.test(c.sourceUrl));
    dropped = before - out.companies.length;
  }
  if (kind === 'job_search') {
    const before = out.listings.length;
    out.listings = out.listings.filter((l: any) => /^https?:\/\//.test(l.url));
    dropped = before - out.listings.length;
  }
  if (kind === 'letter_template') {
    for (const placeholder of ['{firma}', '{firma_giris}', '{firma_baglanti}']) {
      if (!out.body.includes(placeholder)) problems.push(`Kalıpta ${placeholder} yer tutucusu yok`);
    }
  }
  if (kind === 'title_analysis') {
    out.evidenceIds = out.evidenceIds.filter((r: string) => ids.has(r));
  }
  if (kind === 'mail_draft' || kind === 'follow_up') {
    const check = checkDraftContent({
      intent: kind === 'follow_up' ? 'follow_up' : (ctx.intent ?? 'general_intent'),
      subject: out.subject,
      body: out.body,
      verifiedFactsText: ctx.verifiedFactsText ?? '',
      allowedEmails: ctx.allowedEmails ?? [],
    });
    problems.push(...check.problems);
    if (kind === 'mail_draft' && ctx.portfolioCount !== undefined) {
      out.selectedWorkIndexes = out.selectedWorkIndexes.filter((i: number) => i < (ctx.portfolioCount ?? 0));
    }
  }
  if (kind === 'reply_classification' && out.confidence < 0.6) {
    out.needsReview = true;
  }
  return { ok: problems.length === 0, output: out, problems, dropped };
}
