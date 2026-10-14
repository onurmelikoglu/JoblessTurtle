import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as path from 'path';
import { PrismaService } from '../common/prisma.service';
import { pickDocument } from '../domain/documents';
import { StorageService } from '../common/storage.service';
import { AiService } from './ai/ai.service';
import { LetterService } from './letter.service';

const CV_FACT_PREFIX = 'cv-';

type CvFacts = {
  headline?: string | null;
  experienceYears?: number | null;
  phone?: string | null;
  experiences: { company: string; role: string; period?: string | null; technologies: string[]; projects: string[] }[];
  skills: string[];
  education?: string | null;
  languages: string[];
};

type Fact = { key: string; label: string; value: string };

function toFacts(cv: CvFacts): Fact[] {
  const facts: Fact[] = cv.experiences.map((e, i) => ({
    key: `${CV_FACT_PREFIX}exp-${i}`,
    label: `${e.role} — ${e.company}`,
    value: [e.period, e.technologies.length ? `Teknolojiler: ${e.technologies.join(', ')}` : null, e.projects.length ? `Projeler: ${e.projects.join(', ')}` : null].filter(Boolean).join(' · '),
  }));
  if (cv.experienceYears) facts.push({ key: `${CV_FACT_PREFIX}years`, label: 'Toplam deneyim', value: `${cv.experienceYears} yıl` });
  if (cv.skills.length) facts.push({ key: `${CV_FACT_PREFIX}skills`, label: 'Yetkinlikler', value: cv.skills.join(', ') });
  if (cv.education) facts.push({ key: `${CV_FACT_PREFIX}education`, label: 'Eğitim', value: cv.education });
  if (cv.languages.length) facts.push({ key: `${CV_FACT_PREFIX}languages`, label: 'Diller', value: cv.languages.join(', ') });
  return facts.filter((f) => f.value);
}

@Injectable()
export class CandidateFactsService {
  private readonly logger = new Logger('CandidateFacts');

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly ai: AiService,
    private readonly letters: LetterService,
  ) {}

  async ensureFromCv(candidateId: string) {
    const cv = pickDocument(await this.prisma.documentVersion.findMany({ where: { candidateId, type: 'cv', archived: false, scanState: 'clean' } }), 'cv');
    if (!cv) return { status: 'no_cv' as const };
    const marker = `cvfacts:${candidateId}`;
    const done = await this.prisma.keyValue.findUnique({ where: { key: marker } });
    if ((done?.value as { documentId?: string } | null)?.documentId === cv.id) return { status: 'up_to_date' as const };
    const candidate = await this.prisma.candidateProfile.findUniqueOrThrow({ where: { id: candidateId } });
    const fileName = `cv${path.extname(cv.fileName) || '.pdf'}`;
    const r = await this.ai.run({
      workspaceId: candidate.workspaceId,
      kind: 'cv_facts',
      input: { documentId: cv.id, fileName },
      files: [{ name: fileName, data: await this.storage.get(cv.objectKey) }],
      allowManual: false,
      allowTemplate: false,
      entityType: 'CandidateProfile',
      entityId: candidateId,
    });
    if (r.status !== 'succeeded') {
      this.logger.warn(`CV bilgileri çıkarılamadı (${candidateId}): ${r.status}`);
      return { status: 'unavailable' as const };
    }
    const cvFacts = r.output as CvFacts;
    const kept = ((candidate.verifiedFacts ?? []) as Fact[]).filter((f) => !f.key.startsWith(CV_FACT_PREFIX));
    await this.prisma.candidateProfile.update({
      where: { id: candidateId },
      data: {
        verifiedFacts: [...kept, ...toFacts(cvFacts)] as unknown as Prisma.InputJsonValue,
        experienceYears: cvFacts.experienceYears ?? candidate.experienceYears,
        phone: candidate.phone ?? cvFacts.phone ?? null,
        headline: candidate.headline ?? cvFacts.headline ?? null,
      },
    });
    await this.prisma.keyValue.upsert({ where: { key: marker }, create: { key: marker, value: { documentId: cv.id } }, update: { value: { documentId: cv.id } } });
    await this.letters.clearGeneratedTemplates(candidateId);
    return { status: 'updated' as const, facts: toFacts(cvFacts).length };
  }
}
