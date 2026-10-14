import { Injectable } from '@nestjs/common';
import { CandidateProfile, Company, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { buildSignature, INTENT_LABELS } from '../domain/templates';
import { replaceAdWord } from '../domain/text';
import { AiService } from './ai/ai.service';
import { templateOutput } from './ai/template-provider';
import { LearnedModelsService } from './learned-models.service';

export const LETTER_INTENTS = ['general_intent', 'job_application', 'intent_after_closed'] as const;
export type LetterIntent = (typeof LETTER_INTENTS)[number];
export const LETTER_STYLE_KEY = 'letters:style';
export const LETTER_GUIDE_KEY = 'letters:guide';
export const LETTER_PLACEHOLDERS = ['{firma}', '{firma_giris}', '{firma_baglanti}'];

const INTENT_GUIDES: Record<LetterIntent, string> = {
  general_intent: 'Firmada şu anda adayla örtüşen açık bir pozisyon görünmüyor; gelecekteki ihtiyaçlar için açık başvuru yapılıyor. Firmanın yayımladığı bir pozisyondan söz ediyormuş gibi yazma.',
  job_application: 'Firmanın {pozisyon} pozisyonuna başvuruluyor; giriş paragrafında bu pozisyona başvurduğunu belirt.',
  intent_after_closed: 'Firmanın daha önce aradığı {pozisyon} pozisyonu için süreç kapanmış; bunun aynı başvurunun tekrarı değil, yeni bir tanışma ve açık başvuru olduğunu belirt.',
};

export type LetterTemplate = { body: string; source: 'ai' | 'user' | 'default'; updatedAt: string };
type LetterTemplates = Partial<Record<LetterIntent, LetterTemplate>>;

export function isLetterIntent(intent: string): intent is LetterIntent {
  return (LETTER_INTENTS as readonly string[]).includes(intent);
}

export function companyDisplayName(name: string) {
  return name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim() || name;
}

function lettersKey(candidateId: string) {
  return `letters:${candidateId}`;
}

function exampleKey(candidateId: string) {
  return `letters:example:${candidateId}`;
}

const MAX_CANDIDATE_EXAMPLE_CHARS = 4000;

const MIN_REDACTED_NAME_PART = 3;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const PHONE_PATTERN = /(\+?\d[\d\s().-]{8,}\d)/g;
const URL_PATTERN = /https?:\/\/\S+|(?:www\.)?(?:linkedin|github|behance|dribbble)\.com\/\S+/gi;

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactPersonalInfo(text: string, names: (string | null | undefined)[]): string {
  const parts = [...new Set(names.flatMap((n) => (n ?? '').split(/\s+/)).filter((p) => p.length >= MIN_REDACTED_NAME_PART))];
  let out = text.replace(EMAIL_PATTERN, '[e-posta]').replace(URL_PATTERN, '[bağlantı]').replace(PHONE_PATTERN, '[telefon]');
  for (const part of parts) out = out.replace(new RegExp(`(?<![\\p{L}])${escapeRegExp(part)}(?![\\p{L}])`, 'giu'), '[Ad]');
  return out;
}

@Injectable()
export class LetterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly models: LearnedModelsService,
  ) {}

  async styleExample(): Promise<string | null> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: LETTER_STYLE_KEY } });
    return (kv?.value as { text?: string } | null)?.text ?? null;
  }

  private async adminIdentity() {
    const admins = await this.prisma.user.findMany({ where: { isAdmin: true }, select: { displayName: true, memberships: { select: { workspaceId: true } } } });
    const workspaceIds = admins.flatMap((a) => a.memberships.map((m) => m.workspaceId));
    const candidates = await this.prisma.candidateProfile.findMany({ where: { workspaceId: { in: workspaceIds } }, orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true } });
    return { workspaceIds, candidateIds: candidates.map((c) => c.id), names: [...admins.map((a) => a.displayName), ...candidates.map((c) => c.displayName)] };
  }

  async anonymizedStyleExample(): Promise<string | null> {
    const text = await this.styleExample();
    if (!text) return null;
    return replaceAdWord(redactPersonalInfo(text, (await this.adminIdentity()).names));
  }

  /** Davetli adaylar için yöneticinin aynı türdeki kalıbı yapı referansı olarak kullanılır; kişisel bilgiler maskelenir. */
  async referenceTemplate(candidate: CandidateProfile, intent: LetterIntent): Promise<string | null> {
    const admin = await this.adminIdentity();
    if (admin.workspaceIds.includes(candidate.workspaceId)) return null;
    for (const id of admin.candidateIds) {
      const body = (await this.templates(id))[intent]?.body;
      if (body) return redactPersonalInfo(body, admin.names);
    }
    return null;
  }

  async candidateExample(candidateId: string): Promise<string | null> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: exampleKey(candidateId) } });
    return (kv?.value as { text?: string } | null)?.text ?? null;
  }

  async saveCandidateExample(candidateId: string, text: string | null) {
    const key = exampleKey(candidateId);
    const trimmed = text?.trim().slice(0, MAX_CANDIDATE_EXAMPLE_CHARS) || null;
    if (trimmed) await this.prisma.keyValue.upsert({ where: { key }, create: { key, value: { text: trimmed } }, update: { value: { text: trimmed } } });
    else await this.prisma.keyValue.deleteMany({ where: { key } });
    await this.clearGeneratedTemplates(candidateId);
    return { text: trimmed };
  }

  async guideForAi(): Promise<string | null> {
    const guide = await this.guide();
    return guide ? replaceAdWord(guide) : null;
  }

  async guide(): Promise<string | null> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: LETTER_GUIDE_KEY } });
    return (kv?.value as { text?: string } | null)?.text ?? null;
  }

  async saveGuide(text: string) {
    await this.prisma.keyValue.upsert({ where: { key: LETTER_GUIDE_KEY }, create: { key: LETTER_GUIDE_KEY, value: { text } }, update: { value: { text } } });
    return { text };
  }

  async saveStyleExample(text: string) {
    await this.prisma.keyValue.upsert({ where: { key: LETTER_STYLE_KEY }, create: { key: LETTER_STYLE_KEY, value: { text } }, update: { value: { text } } });
    return { text };
  }

  async templates(candidateId: string): Promise<LetterTemplates> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: lettersKey(candidateId) } });
    return (kv?.value ?? {}) as LetterTemplates;
  }

  async saveTemplate(candidateId: string, intent: LetterIntent, body: string, source: LetterTemplate['source']) {
    const all = { ...(await this.templates(candidateId)), [intent]: { body: replaceAdWord(body), source, updatedAt: new Date().toISOString() } };
    await this.prisma.keyValue.upsert({
      where: { key: lettersKey(candidateId) },
      create: { key: lettersKey(candidateId), value: all as unknown as Prisma.InputJsonValue },
      update: { value: all as unknown as Prisma.InputJsonValue },
    });
    return all[intent]!;
  }

  async clearGeneratedTemplates(candidateId: string) {
    const all = await this.templates(candidateId);
    const kept = Object.fromEntries(Object.entries(all).filter(([, t]) => t?.source === 'user'));
    await this.prisma.keyValue.upsert({
      where: { key: lettersKey(candidateId) },
      create: { key: lettersKey(candidateId), value: kept as Prisma.InputJsonValue },
      update: { value: kept as Prisma.InputJsonValue },
    });
  }

  async generateTemplate(candidate: CandidateProfile, intent: LetterIntent, createdById: string | null = null) {
    const input = {
      intent,
      intentLabel: INTENT_LABELS[intent],
      intentGuide: INTENT_GUIDES[intent],
      signature: buildSignature(candidate),
      styleExample: await this.anonymizedStyleExample(),
      guide: await this.guideForAi(),
      referenceTemplate: await this.referenceTemplate(candidate, intent),
      candidateExample: await this.candidateExample(candidate.id),
      hasPortfolio: (await this.prisma.documentVersion.count({ where: { candidateId: candidate.id, type: 'portfolio', archived: false, scanState: 'clean' } })) > 0 || !!candidate.portfolioUrl,
      candidate: { name: candidate.displayName, headline: candidate.headline, experienceYears: candidate.experienceYears, facts: candidate.verifiedFacts },
    };
    const r = await this.ai.run({
      workspaceId: candidate.workspaceId,
      kind: 'letter_template',
      input,
      validation: { intent },
      entityType: 'CandidateProfile',
      entityId: candidate.id,
      createdById,
      allowManual: false,
      useCache: false,
    });
    const body = r.status === 'succeeded' ? (r.output as { body: string }).body : (templateOutput('letter_template', input) as { body: string }).body;
    const source = r.status === 'succeeded' && r.provider !== 'template' ? 'ai' : 'default';
    return this.saveTemplate(candidate.id, intent, body, source);
  }

  async ensureTemplate(candidate: CandidateProfile, intent: LetterIntent) {
    return (await this.templates(candidate.id))[intent] ?? this.generateTemplate(candidate, intent);
  }

  async compose(input: { candidate: CandidateProfile; company: Company; intent: LetterIntent; jobTitle: string | null; jobDescription?: string | null; fresh?: boolean; createdById?: string | null }) {
    const template = await this.ensureTemplate(input.candidate, input.intent);
    const provenExamples = await this.models.provenLetterLines(input.candidate.id, input.company.id);
    const report = input.company.researchReport as { summary?: string | null; applicationAngle?: string | null; roleNeedInference?: { text?: string | null } | null } | null;
    const lineInput = {
      company: {
        name: input.company.name,
        displayName: companyDisplayName(input.company.name),
        sectors: input.company.sectors,
        services: input.company.services.slice(0, 8),
        summary: report?.summary ?? null,
        potential: report?.roleNeedInference?.text ?? null,
        approach: report?.applicationAngle ?? null,
      },
      jobTitle: input.jobTitle,
      job: input.jobTitle ? { title: input.jobTitle, description: (input.jobDescription ?? '').slice(0, 1500) } : null,
      candidate: { headline: input.candidate.headline, experienceYears: input.candidate.experienceYears, facts: input.candidate.verifiedFacts },
      guide: await this.guideForAi(),
      candidateExample: await this.candidateExample(input.candidate.id),
      ...(provenExamples.length ? { provenExamples } : {}),
      templateBody: template.body,
    };
    const r = await this.ai.run({
      workspaceId: input.candidate.workspaceId,
      kind: 'letter_company_line',
      input: lineInput,
      entityType: 'Company',
      entityId: input.company.id,
      createdById: input.createdById ?? null,
      allowManual: false,
      useCache: !input.fresh,
    });
    const lines = (r.status === 'succeeded' ? r.output : templateOutput('letter_company_line', lineInput)) as { opening: string; connection: string };
    const body = template.body
      .replaceAll('{firma_giris}', lines.opening.trim())
      .replaceAll('{firma_baglanti}', lines.connection.trim())
      .replaceAll('{pozisyon}', input.jobTitle ?? '')
      .replaceAll('{firma}', companyDisplayName(input.company.name));
    return { body, generator: r.status === 'succeeded' && r.provider !== 'template' ? `letter:${r.provider}` : 'letter:template' };
  }
}
