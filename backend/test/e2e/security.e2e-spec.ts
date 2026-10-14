import { JwtService } from '@nestjs/jwt';
import { EvaluationService } from '../../src/engine/evaluation.service';
import { SendingService } from '../../src/engine/sending.service';
import { createDraft, createHarness, Harness, idem, resetDb, setupCompanyWithJob, setupUser } from './harness';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
});

afterAll(async () => {
  await h.close();
});

describe('inceleme regresyonları', () => {
  it('erişim token\'ı olmayan imzalı değer (ör. OAuth state) oturum yerine geçemez', async () => {
    const admin = await setupUser(h, 'admin');
    const ws = (await h.http().get('/api/v1/me').set(admin.auth)).body.workspace.id;
    const jwt = h.app.get(JwtService);
    const forged = await jwt.signAsync({ ws, cid: admin.candidate.id, uid: 'x', p: 'gmail' });
    await h.http().get('/api/v1/me').set('Authorization', `Bearer ${forged}`).set('x-workspace-id', ws).expect(401);
    const noType = await jwt.signAsync({ sub: 'someone', email: 'a@b.c' });
    await h.http().get('/api/v1/me').set('Authorization', `Bearer ${noType}`).expect(401);
  });

  it('Gmail OAuth dönüşü, akışı başlatan tarayıcının çerezi olmadan kabul edilmez', async () => {
    const res = await h.http().get('/api/v1/mail-accounts/gmail/callback').query({ code: 'x', state: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }).expect(302);
    expect(res.headers.location).toContain('gmail=error&reason=state');
  });

  it('acil durdur kuyruktaki işleri iptal eder, taslak kilitli kalmaz ve yeniden gönderilebilir', async () => {
    const u = await setupUser(h, 'pause');
    const { company } = await setupCompanyWithJob(h, u, { withJob: false });
    const draft = await createDraft(h, u, company.id, null, { intentType: 'general_intent' });
    const { attempt } = await h.app.get(SendingService).queueSend({ workspaceId: draft.workspaceId, userId: null, draftId: draft.id, idempotencyKey: idem(), sendMode: 'campaign', mailAccountId: u.account.id, scheduledAt: new Date(Date.now() + 3600_000) });
    await h.http().post('/api/v1/automation/pause').set(u.auth).send({}).expect(201);
    expect((await h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).state).toBe('cancelled');
    const d = await h.prisma.applicationDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(d.status).toBe('needs_review');
    await h.http().post('/api/v1/automation/resume').set(u.auth).expect(201);
    // Operasyonel gerekçe (EMERGENCY_STOP) içerik kuralı sayılmaz; manuel gönderim yapılabilir
    const r = await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: d.currentRevision }).expect(202);
    expect(r.body.state).toBe('queued');
  });

  it('yok sayılan fırsat kategori değişse bile geri açılmaz', async () => {
    const u = await setupUser(h, 'dismiss');
    const { job } = await setupCompanyWithJob(h, u);
    const opp = await h.prisma.opportunity.findFirstOrThrow({ where: { jobId: job.id } });
    await h.http().patch(`/api/v1/opportunities/${opp.id}`).set(u.auth).send({ status: 'dismissed' }).expect(200);
    await h.prisma.job.update({ where: { id: job.id }, data: { status: 'stale' } });
    const evaluation = h.app.get(EvaluationService);
    await evaluation.evaluateCompany(job.companyId);
    await h.prisma.job.update({ where: { id: job.id }, data: { status: 'open', lastVerifiedAt: new Date() } });
    await evaluation.evaluateCompany(job.companyId);
    await h.worker.drain();
    const after = await h.prisma.opportunity.findUniqueOrThrow({ where: { id: opp.id } });
    expect(after.status).toBe('dismissed');
    expect(await h.prisma.applicationDraft.count({ where: { opportunityId: opp.id } })).toBe(0);
  });

  it('politika başka workspace\'in arama profiline veya belgelerine bağlanamaz', async () => {
    const a = await setupUser(h, 'pa');
    const b = await setupUser(h, 'pb');
    const p = (await h.http().post('/api/v1/policies').set(a.auth).send({ candidateId: a.candidate.id, searchProfileId: a.profile.id, mailAccountId: a.account.id, name: 'x', documentIds: [a.doc.id] }).expect(201)).body;
    await h.http().patch(`/api/v1/policies/${p.id}`).set(a.auth).send({ searchProfileId: b.profile.id }).expect(404);
    await h.http().patch(`/api/v1/policies/${p.id}`).set(a.auth).send({ documentIds: [b.doc.id] }).expect(422);
  });

  it('engellenmiş (bounce) adrese gönderim yapılmaz; manuel başvuru teyit bekleyen ilana gönderilebilir', async () => {
    const u = await setupUser(h, 'supp');
    const { company, job, contact } = await setupCompanyWithJob(h, u);
    await h.http().patch(`/api/v1/contacts/${contact.id}`).set(u.auth).send({ suppressed: true }).expect(200);
    const d1 = await createDraft(h, u, company.id, job.id, { intentType: 'general_intent' });
    await h.http().patch(`/api/v1/drafts/${d1.id}`).set(u.auth).send({ revision: 1, toEmail: contact.email }).expect(200);
    const r = await h.http().post(`/api/v1/drafts/${d1.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: 2 }).expect(422);
    expect(r.body.error.code).toBe('SUPPRESSED');

    await h.prisma.job.update({ where: { id: job.id }, data: { status: 'unknown' } });
    const d2 = await createDraft(h, u, company.id, job.id);
    await h.http().patch(`/api/v1/drafts/${d2.id}`).set(u.auth).send({ revision: 1, toEmail: `ik@${company.canonicalDomain}` }).expect(200);
    const res = await h.http().post(`/api/v1/drafts/${d2.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: 2 }).expect(202);
    await h.worker.drain();
    expect((await h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: res.body.applicationId } })).state).toBe('provider_accepted');
  });

  it('firma silinince kuyruktaki gönderim iptal edilir', async () => {
    const u = await setupUser(h, 'del');
    const { company } = await setupCompanyWithJob(h, u, { withJob: false });
    const draft = await createDraft(h, u, company.id, null, { intentType: 'general_intent' });
    const { attempt } = await h.app.get(SendingService).queueSend({ workspaceId: draft.workspaceId, userId: null, draftId: draft.id, idempotencyKey: idem(), sendMode: 'manual', mailAccountId: u.account.id, scheduledAt: new Date(Date.now() + 3600_000) });
    await h.http().delete(`/api/v1/companies/${company.id}`).set(u.auth).expect(200);
    expect((await h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).state).toBe('cancelled');
  });
});
