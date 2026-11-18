import { Injectable, Logger } from '@nestjs/common';
import { notFound } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import { PrismaService } from '../common/prisma.service';
import { fmtIstanbul } from '../common/time';
import { INTERVIEW_KIND_LABELS, InterviewKind, InterviewStatus, interviewIcs, OUTCOME_OF_STAGE, PipelineStage, reminderDue, usableInterviewProposal } from '../domain/pipeline';
import { AiService } from './ai/ai.service';
import { RepliesService } from './replies.service';

const UPCOMING_GRACE_MS = 2 * 3600_000;
const UPCOMING_LIMIT = 50;
const EXTRACT_TEXT_LIMIT = 4000;

export interface InterviewInput {
  startsAt: Date;
  durationMin?: number;
  kind?: InterviewKind;
  link?: string | null;
  location?: string | null;
  notes?: string | null;
}

/**
 * Başvurunun süreci: yanıt, mülâkat, teklif, ret gibi aşamalar ve mülâkatlar. Aşama, başvurunun tek "sonuç" alanını
 * da günceller; böylece eski ekranlar ve istatistikler tutarlı kalır. Mülâkat davetinden çıkarılan tarih kullanıcı
 * onaylayana kadar yalnızca öneridir.
 */
@Injectable()
export class PipelineService {
  private readonly logger = new Logger('Pipeline');

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly ai: AiService,
    private readonly replies: RepliesService,
  ) {}

  private async attemptOf(workspaceId: string, attemptId: string) {
    const attempt = await this.prisma.applicationAttempt.findFirst({ where: { id: attemptId, workspaceId } });
    if (!attempt) throw notFound('Başvuru');
    return attempt;
  }

  async addStage(workspaceId: string, attemptId: string, input: { stage: PipelineStage; at?: Date; note?: string | null; source?: 'manual' | 'inbox' }, actorId: string | null) {
    const attempt = await this.attemptOf(workspaceId, attemptId);
    const outcome = OUTCOME_OF_STAGE[input.stage];
    if (outcome && actorId) await this.replies.recordOutcome(workspaceId, attempt.id, outcome, input.note ?? undefined, actorId);
    return this.prisma.applicationStage.create({
      data: { workspaceId, attemptId: attempt.id, stage: input.stage, at: input.at ?? new Date(), note: input.note ?? null, source: input.source ?? 'manual', createdById: actorId },
    });
  }

  async timeline(workspaceId: string, attemptId: string) {
    const [stages, interviews] = await Promise.all([
      this.prisma.applicationStage.findMany({ where: { workspaceId, attemptId }, orderBy: { at: 'asc' } }),
      this.prisma.interview.findMany({ where: { workspaceId, attemptId }, orderBy: { startsAt: 'asc' } }),
    ]);
    return { stages, interviews };
  }

  async createInterview(workspaceId: string, attemptId: string, input: InterviewInput, actorId: string | null) {
    const attempt = await this.attemptOf(workspaceId, attemptId);
    const interview = await this.prisma.interview.create({
      data: { workspaceId, attemptId: attempt.id, startsAt: input.startsAt, durationMin: input.durationMin ?? 60, kind: input.kind ?? 'video', link: input.link ?? null, location: input.location ?? null, notes: input.notes ?? null, status: 'scheduled', source: 'manual' },
    });
    if (!['interview', 'offer'].includes(attempt.outcome ?? '')) await this.addStage(workspaceId, attempt.id, { stage: 'interview' }, actorId).catch((e) => this.logger.warn(`Mülâkat aşaması eklenemedi: ${(e as Error).message}`));
    return interview;
  }

  async updateInterview(workspaceId: string, id: string, patch: Partial<InterviewInput> & { status?: InterviewStatus }) {
    const interview = await this.prisma.interview.findFirst({ where: { id, workspaceId } });
    if (!interview) throw notFound('Mülâkat');
    const moved = patch.startsAt && patch.startsAt.getTime() !== interview.startsAt.getTime();
    return this.prisma.interview.update({
      where: { id },
      data: {
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.startsAt ? { startsAt: patch.startsAt } : {}),
        ...(patch.durationMin ? { durationMin: patch.durationMin } : {}),
        ...(patch.kind ? { kind: patch.kind } : {}),
        ...(patch.link !== undefined ? { link: patch.link } : {}),
        ...(patch.location !== undefined ? { location: patch.location } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(moved ? { remindedDayAt: null, remindedHourAt: null } : {}),
      },
    });
  }

  /** Önerilen ve yaklaşan mülâkatlar (başlamasının üzerinden iki saat geçmemiş olanlar). */
  async upcoming(workspaceId: string, now = new Date()) {
    const interviews = await this.prisma.interview.findMany({
      where: { workspaceId, status: { in: ['proposed', 'scheduled'] }, startsAt: { gte: new Date(now.getTime() - UPCOMING_GRACE_MS) } },
      orderBy: { startsAt: 'asc' },
      take: UPCOMING_LIMIT,
    });
    const attempts = await this.prisma.applicationAttempt.findMany({ where: { id: { in: interviews.map((i) => i.attemptId) } }, select: { id: true, companyId: true, jobId: true } });
    const [companies, jobs] = await Promise.all([
      this.prisma.company.findMany({ where: { id: { in: attempts.map((a) => a.companyId) } }, select: { id: true, name: true } }),
      this.prisma.job.findMany({ where: { id: { in: attempts.map((a) => a.jobId).filter((id): id is string => !!id) } }, select: { id: true, title: true } }),
    ]);
    const attemptById = new Map(attempts.map((a) => [a.id, a]));
    const companyName = new Map(companies.map((c) => [c.id, c.name]));
    const jobTitle = new Map(jobs.map((j) => [j.id, j.title]));
    return interviews.map((i) => {
      const a = attemptById.get(i.attemptId);
      return { ...i, company: (a && companyName.get(a.companyId)) ?? 'Firma', title: a?.jobId ? (jobTitle.get(a.jobId) ?? null) : null };
    });
  }

  async ics(workspaceId: string, id: string) {
    const interview = await this.prisma.interview.findFirst({ where: { id, workspaceId } });
    if (!interview) throw notFound('Mülâkat');
    const attempt = await this.prisma.applicationAttempt.findUnique({ where: { id: interview.attemptId }, select: { companyId: true } });
    const company = attempt ? await this.prisma.company.findUnique({ where: { id: attempt.companyId }, select: { name: true } }) : null;
    return interviewIcs(interview, company?.name ?? 'Firma');
  }

  /** Mülâkat davetinden tarih ve ayrıntılar çıkarılır; bulunursa kullanıcının onayına sunulan bir öneri oluşur. */
  async extractFromMessage(messageId: string, now = new Date()) {
    const message = await this.prisma.inboundMessage.findUnique({ where: { id: messageId } });
    if (!message?.attemptId) return { status: 'skipped' as const };
    if (await this.prisma.interview.findFirst({ where: { inboundMessageId: message.id }, select: { id: true } })) return { status: 'exists' as const };
    const r = await this.ai.run({
      workspaceId: message.workspaceId,
      kind: 'interview_extract',
      input: { now: now.toISOString(), subject: message.subject, text: (message.bodyText ?? message.snippet ?? '').slice(0, EXTRACT_TEXT_LIMIT) },
      entityType: 'InboundMessage',
      entityId: message.id,
      allowManual: false,
      allowTemplate: false,
    });
    if (r.status !== 'succeeded') return { status: r.status };
    const out = r.output as { startsAt?: string | null; durationMin?: number | null; kind?: InterviewKind | null; link?: string | null; location?: string | null; confidence?: number; note?: string | null };
    const startsAt = usableInterviewProposal(out, now.getTime());
    if (!startsAt) return { status: 'no_date' as const };
    const interview = await this.prisma.interview.create({
      data: {
        workspaceId: message.workspaceId,
        attemptId: message.attemptId,
        startsAt,
        durationMin: out.durationMin ?? 60,
        kind: out.kind ?? 'video',
        link: out.link ?? null,
        location: out.location ?? null,
        notes: out.note ?? null,
        status: 'proposed',
        source: 'inbox',
        inboundMessageId: message.id,
      },
    });
    const company = await this.companyNameOf(message.attemptId);
    await this.outbox.emit({
      workspaceId: message.workspaceId,
      eventType: 'notify',
      aggregateId: interview.id,
      dedupKey: `interview-proposed:${interview.id}`,
      payload: { type: 'interview', title: `Mülâkat daveti: ${company}`, body: `${fmtIstanbul(startsAt)} için görüşme önerisi. Başvurularım'dan onaylayıp takvimine ekleyebilirsin.`, link: '/?tab=basvurular' },
    });
    return { status: 'proposed' as const, interviewId: interview.id };
  }

  async sendReminders(now = new Date()) {
    const soon = await this.prisma.interview.findMany({ where: { status: 'scheduled', startsAt: { gt: now, lte: new Date(now.getTime() + 25 * 3600_000) } } });
    let sent = 0;
    for (const i of soon) {
      const due = reminderDue(i, now.getTime());
      if (!due) continue;
      const company = await this.companyNameOf(i.attemptId);
      const where = i.link ?? i.location ?? INTERVIEW_KIND_LABELS[i.kind as InterviewKind] ?? '';
      await this.outbox.emit({
        workspaceId: i.workspaceId,
        eventType: 'notify',
        aggregateId: i.id,
        dedupKey: `interview-reminder:${i.id}:${due}:${i.startsAt.toISOString()}`,
        payload: { type: 'interview', title: due === 'hour' ? `Bir saat sonra mülâkat: ${company}` : `Yarın mülâkat: ${company}`, body: `${fmtIstanbul(i.startsAt)}${where ? ` · ${where}` : ''}`, link: '/?tab=basvurular' },
      });
      await this.prisma.interview.update({ where: { id: i.id }, data: due === 'hour' ? { remindedHourAt: now } : { remindedDayAt: now } });
      sent++;
    }
    return { sent };
  }

  private async companyNameOf(attemptId: string) {
    const attempt = await this.prisma.applicationAttempt.findUnique({ where: { id: attemptId }, select: { companyId: true } });
    const company = attempt ? await this.prisma.company.findUnique({ where: { id: attempt.companyId }, select: { name: true } }) : null;
    return company?.name ?? 'Firma';
  }
}
