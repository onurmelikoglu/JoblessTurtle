import ExcelJS from 'exceljs';
import { createHmac } from 'crypto';
import { SendingService } from '../../src/engine/sending.service';
import { fakeProvider } from '../../src/engine/mail/providers';
import { IngestService } from '../../src/engine/ingest.service';
import { ResearchService } from '../../src/engine/research.service';
import { resetEnvForTests } from '../../src/common/env';
import { resetProviderCache } from '../../src/engine/ai/providers';
import { chmodSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { createDraft, createHarness, Harness, idem, resetDb, setupCompanyWithJob, setupUser, User } from './harness';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
});

afterAll(async () => {
  await h.close();
});

// Başarısız bir testte geri alınmayan casus sonraki testlere taşınıp sahte hata üretmesin.
afterEach(() => {
  jest.restoreAllMocks();
});

describe('kullanıcı ayrımı (arkadaş pilotu)', () => {
  let a: User;
  let b: User;

  beforeAll(async () => {
    a = await setupUser(h, 'alice');
    b = await setupUser(h, 'bob');
  });

  it('ilk kullanıcı yönetici, sonrakiler değil; her kullanıcının ayrı workspace\'i var', async () => {
    const meA = (await h.http().get('/api/v1/me').set(a.auth).expect(200)).body;
    const meB = (await h.http().get('/api/v1/me').set(b.auth).expect(200)).body;
    expect(meA.user.isAdmin).toBe(true);
    expect(meB.user.isAdmin).toBe(false);
    expect(meA.workspace.id).not.toBe(meB.workspace.id);
  });

  it('B, A\'nın CV, taslak, mail hesabı ve başvuru geçmişine API üzerinden erişemez', async () => {
    const { company, job } = await setupCompanyWithJob(h, a);
    const draft = await createDraft(h, a, company.id, job.id);
    await h.http().get(`/api/v1/candidates/${a.candidate.id}`).set(b.auth).expect(404);
    await h.http().get(`/api/v1/documents/${a.doc.id}/download`).set(b.auth).expect(404);
    await h.http().get(`/api/v1/drafts/${draft.id}`).set(b.auth).expect(404);
    await h.http().get(`/api/v1/companies/${company.id}`).set(b.auth).expect(404);
    await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(b.auth).set('Idempotency-Key', idem()).send({ expectedRevision: 1 }).expect(404);
    const bDrafts = (await h.http().get('/api/v1/drafts').set(b.auth).expect(200)).body.items;
    expect(bDrafts.find((d: any) => d.id === draft.id)).toBeUndefined();
    const bAccounts = (await h.http().get('/api/v1/mail-accounts').set(b.auth).expect(200)).body.accounts;
    expect(bAccounts.map((x: any) => x.id)).not.toContain(a.account.id);
    expect(JSON.stringify(bAccounts)).not.toContain('encryptedSecret');
  });

  it('başka adayın mail hesabı ve belgeleri gönderime taşınamaz', async () => {
    const { company, job } = await setupCompanyWithJob(h, a);
    await h.http().post('/api/v1/drafts').set(a.auth).send({ candidateId: a.candidate.id, companyId: company.id, jobId: job.id, mailAccountId: b.account.id, useAi: false }).expect(422);
    const draft = await createDraft(h, a, company.id, job.id);
    await h.http().patch(`/api/v1/drafts/${draft.id}`).set(a.auth).send({ revision: 1, documentIds: [b.doc.id] }).expect(422);
  });
});

describe('tekil gönderim, idempotency ve tekrar engeli', () => {
  let u: User;
  beforeAll(async () => {
    u = await setupUser(h, 'solo');
  });

  it('gönder → 202 queued → worker → provider_accepted; kabul teslim garantisi olarak sunulmaz', async () => {
    const { company, job } = await setupCompanyWithJob(h, u);
    const draft = await createDraft(h, u, company.id, job.id);
    const key = idem();
    const res = await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(u.auth).set('Idempotency-Key', key).send({ expectedRevision: 1 }).expect(202);
    expect(res.body.state).toBe('queued');
    await h.worker.drain();
    const app = (await h.http().get(`/api/v1/applications/${res.body.applicationId}`).set(u.auth).expect(200)).body;
    expect(app.attempt.state).toBe('provider_accepted');
    expect(app.attempt.providerMessageId).toMatch(/^fake-/);
    const notes = (await h.http().get('/api/v1/notifications').set(u.auth).expect(200)).body;
    expect(notes.find((n: any) => n.type === 'send_accepted').body).toMatch(/garanti/);

    // Aynı anahtar + aynı içerik → aynı başvuru; farklı içerik → 409
    const again = await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(u.auth).set('Idempotency-Key', key).send({ expectedRevision: 1 }).expect(202);
    expect(again.body.applicationId).toBe(res.body.applicationId);
    expect(again.body.reused).toBe(true);
    const conflict = await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(u.auth).set('Idempotency-Key', key).send({ expectedRevision: 2 }).expect(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    // Aynı aday + aynı kanonik ilan için ikinci başvuru engellenir
    const draft2 = await createDraft(h, u, company.id, job.id);
    const dup = await h.http().post(`/api/v1/drafts/${draft2.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: 1 }).expect(409);
    expect(dup.body.error.code).toBe('ALREADY_APPLIED');
  });

  it('Idempotency-Key olmadan gönderim reddedilir; onaylı sürüm değiştiyse DOCUMENT_CHANGED', async () => {
    const { company, job } = await setupCompanyWithJob(h, u);
    const draft = await createDraft(h, u, company.id, job.id);
    await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(u.auth).send({ expectedRevision: 1 }).expect(400);
    await h.http().patch(`/api/v1/drafts/${draft.id}`).set(u.auth).send({ revision: 1, subject: 'Yeni konu başlığı' }).expect(200);
    const r = await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: 1 }).expect(409);
    expect(r.body.error.code).toBe('DOCUMENT_CHANGED');
    // Eski ekran yeni veriyi ezemez
    const stale = await h.http().patch(`/api/v1/drafts/${draft.id}`).set(u.auth).send({ revision: 1, body: 'Eski ekrandan gelen değişiklik metni.' }).expect(409);
    expect(stale.body.error.code).toBe('REVISION_CONFLICT');
  });

  it('kuyruktayken taslak sürümü değişirse worker göndermez (yanlış ek yok)', async () => {
    const { company, job } = await setupCompanyWithJob(h, u);
    const draft = await createDraft(h, u, company.id, job.id);
    const res = await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: 1 }).expect(202);
    // Motor seviyesinde sürüm değişimi (ör. otomatik belge geçişi) simülasyonu
    const d = await h.prisma.applicationDraft.findUniqueOrThrow({ where: { id: draft.id } });
    const drafting = h.app.get((await import('../../src/engine/drafting.service')).DraftingService);
    const cur = await drafting.currentRevision(draft.id);
    await drafting.addRevision(d, { toEmail: cur!.toEmail, subject: cur!.subject, body: `${cur!.body}\nEk`, documentIds: [], links: [] }, { createdById: null, generator: 'user' });
    const spy = jest.spyOn(fakeProvider, 'send');
    const result = await h.app.get(SendingService).processAttempt(res.body.applicationId);
    expect(result).toBe('blocked:DOCUMENT_CHANGED');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('eşzamanlı iki worker: tek gönderim; DB kilidi ikinci dış çağrıyı engeller', async () => {
    const { company, job } = await setupCompanyWithJob(h, u);
    const draft = await createDraft(h, u, company.id, job.id);
    const res = await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: 1 }).expect(202);
    const spy = jest.spyOn(fakeProvider, 'send');
    const sending = h.app.get(SendingService);
    const results = await Promise.all([sending.processAttempt(res.body.applicationId), sending.processAttempt(res.body.applicationId)]);
    expect(results.sort()).toEqual(['provider_accepted', 'skipped']);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('timeout sonrası belirsiz gönderim: submission_unknown, otomatik resend yok, kullanıcı uzlaştırır', async () => {
    const { company } = await setupCompanyWithJob(h, u, { withJob: false });
    const draft = await createDraft(h, u, company.id, null, { intentType: 'general_intent' });
    await h.http().patch(`/api/v1/drafts/${draft.id}`).set(u.auth).send({ revision: 1, toEmail: `ik+timeout@${company.canonicalDomain}` }).expect(200);
    const res = await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: 2 }).expect(202);
    await h.worker.drain();
    const spy = jest.spyOn(fakeProvider, 'send');
    let a = await h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: res.body.applicationId } });
    expect(a.state).toBe('submission_unknown');
    await h.app.get(SendingService).reconcile();
    await h.worker.drain();
    expect(spy).not.toHaveBeenCalled();
    a = await h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: a.id } });
    expect(a.state).toBe('submission_unknown');
    const r = await h.http().post(`/api/v1/applications/${a.id}/resolve`).set(u.auth).send({ sent: true }).expect(201);
    expect(r.body.state).toBe('provider_accepted');
    spy.mockRestore();
  });

  it('tahmin edilmiş adrese gönderim yapılmaz', async () => {
    const { company } = await setupCompanyWithJob(h, u, { withJob: false, contactKind: 'guessed' });
    const draft = await createDraft(h, u, company.id, null, { intentType: 'general_intent' });
    const r = await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: 1 });
    expect([409, 422]).toContain(r.status);
  });
});

describe('otomasyon, acil durdur ve dry run', () => {
  let u: User;
  let policyId: string;

  beforeAll(async () => {
    u = await setupUser(h, 'auto');
    const p = await h
      .http()
      .post('/api/v1/policies')
      .set(u.auth)
      .send({ candidateId: u.candidate.id, searchProfileId: u.profile.id, mailAccountId: u.account.id, name: 'Oto', modeJobApplication: true, documentIds: [u.doc.id], sendImmediately: true, qMin: 0, coverageMin: 0, fMin: 60 })
      .expect(201);
    policyId = p.body.id;
  });

  it('dry run yan etkisizdir ve gerekçeleri gösterir; yakın rol opt-in kapalıysa gönderim yok', async () => {
    const { job } = await setupCompanyWithJob(h, u, { title: 'Head of Creative' });
    const rows = (await h.http().post(`/api/v1/policies/${policyId}/dry-run`).set(u.auth).expect(201)).body;
    const row = rows.find((r: any) => r.job === job.title);
    expect(row.decision.eligible).toBe(false);
    expect(row.decision.reasons).toContain('ADJACENT_NOT_ALLOWED');
    expect(await h.prisma.applicationAttempt.count({ where: { candidateId: u.candidate.id } })).toBe(0);
  });

  it('aktif politika uygun açık hedef ilana otomatik başvurur; acil durdur kuyruktakileri iptal eder', async () => {
    await h.http().post(`/api/v1/policies/${policyId}/activate`).set(u.auth).expect(201);
    const { job } = await setupCompanyWithJob(h, u, { title: 'Creative Director' });
    const attempt = await h.prisma.applicationAttempt.findFirst({ where: { jobId: job.id } });
    expect(attempt?.sendMode).toBe('auto');
    expect(attempt?.state).toBe('provider_accepted');

    // Kuyruktaki (ileri tarihli) otomatik iş acil durdur ile gönderici çağrısından önce iptal edilir
    const other = await setupCompanyWithJob(h, u, { withJob: false });
    const draft = await createDraft(h, u, other.company.id, null, { intentType: 'general_intent' });
    const pv = await h.prisma.automationPolicyVersion.findFirstOrThrow({ where: { policyId }, orderBy: { version: 'desc' } });
    const { attempt: queued } = await h.app.get(SendingService).queueSend({ workspaceId: draft.workspaceId, userId: null, draftId: draft.id, idempotencyKey: idem(), sendMode: 'auto', policyVersionId: pv.id, mailAccountId: u.account.id, scheduledAt: new Date(Date.now() + 3600_000) });
    await h.http().post('/api/v1/automation/pause').set(u.auth).send({ reason: 'test' }).expect(201);
    const after = await h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: queued.id } });
    expect(after.state).toBe('cancelled');
    expect(after.stateReason).toBe('EMERGENCY_STOP');
    await h.http().post('/api/v1/automation/resume').set(u.auth).expect(201);
  });

  it('politika devre dışı bırakılınca kuyruktaki otomatik iş sağlayıcı çağrısından önce iptal edilir', async () => {
    await h.http().post('/api/v1/automation/pause').set(u.auth).send({}).expect(201);
    const { job } = await setupCompanyWithJob(h, u, { title: 'Creative Director', location: 'Üsküdar, İstanbul' });
    await h.http().post('/api/v1/automation/resume').set(u.auth).expect(201);
    // Durdurma sırasında otomatik taslak oluşmadıysa politika sürümüyle manuel bir kuyruk işi üret
    const pv = await h.prisma.automationPolicyVersion.findFirstOrThrow({ where: { policyId }, orderBy: { version: 'desc' } });
    const draft = await createDraft(h, u, job.companyId, job.id);
    const sending = h.app.get(SendingService);
    const { attempt } = await sending.queueSend({ workspaceId: draft.workspaceId, userId: null, draftId: draft.id, idempotencyKey: idem(), sendMode: 'auto', policyVersionId: pv.id, mailAccountId: u.account.id });
    await h.http().post(`/api/v1/policies/${policyId}/deactivate`).set(u.auth).expect(201);
    const spy = jest.spyOn(fakeProvider, 'send');
    const r = await sending.processAttempt(attempt.id);
    expect(r).toBe('skipped');
    const a = await h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(a.state).toBe('cancelled');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('toplu kampanya', () => {
  it('her alıcıya ayrı ileti; hatalı satır diğerlerini değiştirmez', async () => {
    const u = await setupUser(h, 'camp');
    const ok1 = await setupCompanyWithJob(h, u, { withJob: false });
    const ok2 = await setupCompanyWithJob(h, u, { withJob: false });
    const bad = await setupCompanyWithJob(h, u, { withJob: false, contactKind: 'guessed' });
    const created = (
      await h
        .http()
        .post('/api/v1/campaigns')
        .set(u.auth)
        .send({ candidateId: u.candidate.id, mailAccountId: u.account.id, name: 'Kampanya', intentType: 'general_intent', companyIds: [ok1.company.id, ok2.company.id, bad.company.id], documentIds: [u.doc.id], subjectTemplate: '{company} için tanışma — {candidate_name}', bodyTemplate: 'Merhaba {company} ekibi,\n\nÜretimlerinizi takip ediyorum. {headline}\n\nPortföyüm: {portfolio_url}\n\n{signature}' })
        .expect(201)
    ).body;
    expect(created.rows).toHaveLength(3);
    const start = (await h.http().post(`/api/v1/campaigns/${created.campaign.id}/start`).set(u.auth).expect(201)).body;
    expect(start.results.filter((r: any) => r.ok)).toHaveLength(2);
    // Aralıklı planlanan işleri test için hemen çalıştır
    await h.prisma.applicationAttempt.updateMany({ where: { campaignId: created.campaign.id }, data: { scheduledAt: null } });
    for (const a of await h.prisma.applicationAttempt.findMany({ where: { campaignId: created.campaign.id } })) await h.app.get(SendingService).processAttempt(a.id);
    const attempts = await h.prisma.applicationAttempt.findMany({ where: { campaignId: created.campaign.id } });
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((a) => a.toEmail)).size).toBe(2);
    expect(attempts.every((a) => a.state === 'provider_accepted')).toBe(true);
    const badDraft = await h.prisma.applicationDraft.findFirstOrThrow({ where: { campaignId: created.campaign.id, companyId: bad.company.id } });
    expect(badDraft.status).toBe('needs_review');
  });
});

describe('aralıklı gönderim', () => {
  const previous = process.env.SEND_PACING_ENABLED;

  beforeAll(() => {
    process.env.SEND_PACING_ENABLED = 'true';
    resetEnvForTests();
  });

  afterAll(() => {
    process.env.SEND_PACING_ENABLED = previous;
    resetEnvForTests();
  });

  it('aynı hesaptan ikinci gönderim 30-50 sn sonraya ertelenir; sağlayıcı yalnızca ilki için çağrılır', async () => {
    const u = await setupUser(h, 'pace');
    const first = await setupCompanyWithJob(h, u, { withJob: false });
    const second = await setupCompanyWithJob(h, u, { withJob: false });
    const queue = async (companyId: string) => {
      const draft = await createDraft(h, u, companyId, null, { intentType: 'general_intent' });
      const res = await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: 1 }).expect(202);
      return res.body.applicationId as string;
    };
    const firstId = await queue(first.company.id);
    const secondId = await queue(second.company.id);
    const spy = jest.spyOn(fakeProvider, 'send');
    const sending = h.app.get(SendingService);
    expect(await sending.processAttempt(firstId)).toBe('provider_accepted');
    expect(await sending.processAttempt(secondId)).toBe('paced');
    expect(spy).toHaveBeenCalledTimes(1);
    const paced = await h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: secondId } });
    expect(paced.state).toBe('queued');
    expect(paced.stateReason).toBe('PACING');
    // Test veritabanının saati makineninkinden ~1 sn geride kalabilir; sınırlar bu payı içerir.
    const waitMs = paced.scheduledAt!.getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(25_000);
    expect(waitMs).toBeLessThan(55_000);
  });
});

describe('yanıt, takip ve webhook', () => {
  it('imzasız webhook reddedilir; tekrar eden olay tekilleşir; insan yanıtı takibi iptal eder', async () => {
    const u = await setupUser(h, 'hook');
    const { company, job } = await setupCompanyWithJob(h, u);
    const draft = await createDraft(h, u, company.id, job.id);
    const res = await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: 1 }).expect(202);
    await h.worker.drain();
    const followUp = await h.prisma.followUp.findUniqueOrThrow({ where: { attemptId: res.body.applicationId } });
    expect(followUp.state).toBe('pending');
    const ws = (await h.http().get('/api/v1/me').set(u.auth)).body.workspace.id;
    const payload = JSON.stringify({ workspaceId: ws, attemptId: res.body.applicationId, messageId: 'm-1', subject: 'Re: başvuru', snippet: 'Merhaba, görüşme için uygun musunuz?', classification: 'interview' });
    await h.http().post('/api/v1/webhooks/gmail').set('content-type', 'application/json').set('x-event-id', 'e-1').send(payload).expect(401);
    const sig = `sha256=${createHmac('sha256', 'test-secret').update(payload).digest('hex')}`;
    const first = await h.http().post('/api/v1/webhooks/gmail').set('content-type', 'application/json').set('x-event-id', 'e-1').set('x-signature', sig).send(payload).expect(201);
    expect(first.body.matched).toBe(true);
    const second = await h.http().post('/api/v1/webhooks/gmail').set('content-type', 'application/json').set('x-event-id', 'e-1').set('x-signature', sig).send(payload).expect(201);
    expect(second.body.duplicate).toBe(true);
    expect(await h.prisma.inboundMessage.count({ where: { attemptId: res.body.applicationId } })).toBe(1);
    const f = await h.prisma.followUp.findUniqueOrThrow({ where: { attemptId: res.body.applicationId } });
    expect(f.state).toBe('cancelled');
    const a = await h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: res.body.applicationId } });
    expect(a.state).toBe('replied');
  });
});

describe('kaynak kuralları', () => {
  it('403 kaynak blocked olur; ilan kapanmaz; resmî kapanış ikincil kopya ile açılmaz', async () => {
    const u = await setupUser(h, 'src');
    const ws = (await h.http().get('/api/v1/me').set(u.auth)).body.workspace.id;
    const src = (
      await h
        .http()
        .post('/api/v1/sources')
        .set(u.auth)
        .send({ kind: 'demo', name: 'Demo', config: { run: 1, blockAtRun: 2, listings: [{ externalId: 'X1', title: 'Creative Director', companyName: 'Resmi Ajans', companyDomain: 'resmiajans.example', locationText: 'Kadıköy' }] } })
        .expect(201)
    ).body;
    const ingest = h.app.get(IngestService);
    await ingest.runSource(src.id);
    const job = await h.prisma.job.findFirstOrThrow({ where: { workspaceId: ws, title: 'Creative Director' } });
    expect(job.status).toBe('open');
    await ingest.runSource(src.id); // run 2 → 403
    const s = await h.prisma.sourceConnector.findUniqueOrThrow({ where: { id: src.id } });
    expect(s.health).toBe('blocked');
    expect((await h.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('open');

    // İkincil kaynakta aynı ilanın açık kopyası + resmî kapanış
    await h.http().post('/api/v1/jobs/manual').set(u.auth).send({ platform: 'linkedin', companyId: job.companyId, title: 'Creative Director', locationText: 'Kadıköy' }).expect(201);
    await h.prisma.jobListing.updateMany({ where: { jobId: job.id, isOfficial: true }, data: { status: 'closed' } });
    await h.prisma.sourceConnector.update({ where: { id: src.id }, data: { health: 'healthy' } });
    const merged = await ingest.refreshJob(job.id);
    expect(merged!.status).toBe('closed');
    expect(merged!.conflict).toBeTruthy();
  });

  it('SSRF: özel ağ adresli kariyer sayfası kaynağı reddedilir', async () => {
    const u = await setupUser(h, 'ssrf');
    const r = await h.http().post('/api/v1/sources').set(u.auth).send({ kind: 'career_page', name: 'x', config: { url: 'http://169.254.169.254/latest' } }).expect(400);
    expect(r.body.error.code).toBe('CONFIG_INVALID');
  });
});

describe('manuel AI köprüsü', () => {
  it('istem bekler; kurala aykırı cevap reddedilir; geçerli cevap taslağa yeni sürüm ekler', async () => {
    const u = await setupUser(h, 'bridge');
    await h.http().patch('/api/v1/ai/settings').set(u.auth).send({ providerOrder: ['manual', 'template'] }).expect(200);
    const { company } = await setupCompanyWithJob(h, u, { withJob: false });
    // Açık başvuru ve ilan yazıları LetterService ile kalıptan üretilir; manuel köprü serbest e-posta taslağında kalır.
    const draft = (await h.http().post('/api/v1/drafts').set(u.auth).send({ candidateId: u.candidate.id, companyId: company.id, intentType: 'project_collab', mailAccountId: u.account.id }).expect(201)).body;
    expect(draft.aiStatus).toBe('awaiting_user');
    const task = (await h.http().get(`/api/v1/ai/tasks/${draft.aiTaskId}`).set(u.auth).expect(200)).body;
    expect(task.prompt).toContain('untrusted_source');
    const bad = await h.http().post(`/api/v1/ai/tasks/${task.id}/submit`).set(u.auth).send({ text: JSON.stringify({ subject: 'Başvuru', body: 'Merhaba, ilanınıza başvuruyorum. Ekte CV mevcut, teşekkürler.' }) }).expect(422);
    expect(bad.body.error.code).toBe('AI_OUTPUT_INVALID');
    await h
      .http()
      .post(`/api/v1/ai/tasks/${task.id}/submit`)
      .set(u.auth)
      .send({ text: '```json\n{"subject":"Tanışma talebi","body":"Merhaba, üretimlerinizi takip ediyorum ve ekibinizle tanışmak isterim. Portföyümü paylaşıyorum.","selectedWorkIndexes":[0]}\n```' })
      .expect(201);
    await h.worker.drain();
    const d = (await h.http().get(`/api/v1/drafts/${draft.id}`).set(u.auth).expect(200)).body;
    expect(d.current.generator).toBe('ai:manual');
    expect(d.current.subject).toBe('Tanışma talebi');
  });
});

describe('unvan odaklı firma keşfi', () => {
  it('arama profili kaydedilince tüm unvanlarla keşif görevi açılır; profil değişince yenilenir', async () => {
    const u = await setupUser(h, 'kesif');
    await h.worker.drain();
    const tasks = await h.prisma.aiTask.findMany({ where: { workspaceId: u.candidate.workspaceId, kind: 'company_discovery' } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('awaiting_user');
    for (const t of ['Kreatif Direktör', 'Creative Director', 'Head of Creative', 'Art Director', 'Kadıköy']) expect(tasks[0].prompt).toContain(t);
    // Unvan dışı değişiklik keşfi tetiklemez; unvan değişikliği arka planda (manuel görev açmadan) yeniler.
    const p1 = (await h.http().patch(`/api/v1/search-profiles/${u.profile.id}`).set(u.auth).send({ revision: u.profile.revision, name: 'Yeni ad' }).expect(200)).body;
    const p2 = (await h.http().patch(`/api/v1/search-profiles/${u.profile.id}`).set(u.auth).send({ revision: p1.revision, exactTitles: ['Kreatif Direktör', 'Group Creative Head'] }).expect(200)).body;
    const events = await h.prisma.outboxEvent.findMany({ where: { workspaceId: u.candidate.workspaceId, eventType: 'discovery.ai' } });
    expect(events.map((e) => e.dedupKey).sort()).toEqual([`discovery:profile:${u.profile.id}:1`, `discovery:profile:${u.profile.id}:${p2.revision}`].sort());
    await h.worker.drain();
    expect(await h.prisma.aiTask.count({ where: { workspaceId: u.candidate.workspaceId, kind: 'company_discovery' } })).toBe(1);
  });

  it('keşif sonucu: resmî kariyer/ATS kaynağı açılır; özel ağ adresi reddedilir; bilinen firma tekrar oluşmaz', async () => {
    const u = await setupUser(h, 'kesif2');
    await h.worker.drain();
    const { company: known, domain: knownDomain } = await setupCompanyWithJob(h, u, { withJob: false });
    const task = await h.prisma.aiTask.findFirstOrThrow({ where: { workspaceId: u.candidate.workspaceId, kind: 'company_discovery' } });
    const research = h.app.get(ResearchService);
    const created = await research.applyDiscovery(
      u.candidate.workspaceId,
      {
        companies: [
          {
            name: 'Yeni Ajans',
            domain: 'yeniajans.example',
            reason: 'Creative Director ilanı açık',
            sourceUrl: 'https://yeniajans.example/kariyer',
            signal: 'open_role',
            careersUrl: 'https://yeniajans.example/kariyer',
            atsUrl: 'https://boards.greenhouse.io/yeniajans',
            openRoles: [{ title: 'Creative Director', url: 'https://boards.greenhouse.io/yeniajans/jobs/42' }],
          },
          { name: 'İç Ağ', domain: 'icag.example', reason: 'x', sourceUrl: 'https://icag.example', signal: 'open_role', careersUrl: 'http://169.254.169.254/latest', openRoles: [] },
          { name: known.name, domain: knownDomain, reason: 'tekrar', sourceUrl: `https://${knownDomain}`, signal: 'sector_fit', openRoles: [] },
        ],
      },
      task.id,
    );
    expect(created).toBe(2);
    const companies = await h.prisma.company.findMany({ where: { workspaceId: u.candidate.workspaceId }, include: { sources: true } });
    expect(companies.filter((c) => c.canonicalDomain === knownDomain)).toHaveLength(1);
    const fresh = companies.find((c) => c.canonicalDomain === 'yeniajans.example')!;
    expect(fresh.origin).toBe('discovery');
    expect(fresh.notes).toContain('Görülen rol: Creative Director');
    expect(fresh.sources.map((s) => s.kind).sort()).toEqual(['career_page', 'greenhouse']);
    expect(fresh.sources.find((s) => s.kind === 'greenhouse')!.config).toEqual({ boardToken: 'yeniajans' });
    const internal = companies.find((c) => c.canonicalDomain === 'icag.example')!;
    expect(internal.sources).toHaveLength(0);
    // Bu testte ağa çıkılmaz: bekleyen tarama/araştırma olayları temizlenir.
    await h.prisma.outboxEvent.deleteMany({ where: { workspaceId: u.candidate.workspaceId, processingState: 'pending' } });
  });

  it('Claude Code CLI köprüsüyle arka planda keşif: firma ve kariyer kaynağı kendiliğinden oluşur', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fake-claude-discovery-'));
    const bin = path.join(dir, 'claude');
    const result = JSON.stringify({
      companies: [{ name: 'CLI Ajans', domain: 'cliajans.example', reason: 'Kreatif Direktör ilanı', sourceUrl: 'https://cliajans.example/kariyer', signal: 'open_role', careersUrl: 'https://cliajans.example/kariyer', openRoles: [{ title: 'Kreatif Direktör' }] }],
    });
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi\ncat > /dev/null\necho '${JSON.stringify({ type: 'result', is_error: false, result })}'\n`);
    chmodSync(bin, 0o755);
    const prev = process.env.CLAUDE_CLI_PATH;
    process.env.CLAUDE_CLI_PATH = bin;
    resetEnvForTests();
    resetProviderCache();
    try {
      const u = await setupUser(h, 'kesifcli');
      await h.worker.drain();
      await h.prisma.user.updateMany({ where: { email: u.email }, data: { isAdmin: true } });
      await h.http().patch('/api/v1/ai/settings').set(u.auth).send({ providerOrder: ['cli_claude', 'template'] }).expect(200);
      const r = await h.app.get(ResearchService).discover(u.candidate.workspaceId, { allowManual: false });
      expect(r).toMatchObject({ status: 'succeeded', provider: 'cli_claude', created: 1 });
      const c = await h.prisma.company.findFirstOrThrow({ where: { workspaceId: u.candidate.workspaceId, canonicalDomain: 'cliajans.example' }, include: { sources: true } });
      expect(c.sources.map((s) => s.kind)).toEqual(['career_page']);
      await h.prisma.outboxEvent.deleteMany({ where: { workspaceId: u.candidate.workspaceId, processingState: 'pending' } });
    } finally {
      process.env.CLAUDE_CLI_PATH = prev;
      resetEnvForTests();
      resetProviderCache();
    }
  });
});

describe('Excel içe aktarma ve dışa aktarma', () => {
  it('firma satırları kayıpsız alınır; detaylar tekrar firma sayılmaz; anonim fırsat ayrı; geçmiş başvuru tekrar engeline girer', async () => {
    const u = await setupUser(h, 'excel');
    const wb = new ExcelJS.Workbook();
    const s1 = wb.addWorksheet('Firmalar');
    s1.addRow(['Firma Adı', 'Web Sitesi', 'İlçe', 'Sektör', 'E-posta', 'Başvuru Durumu', 'Notlar', 'Pozisyon']);
    s1.addRow(['Alfa Ajans', 'alfaajans.example', 'Kadıköy', 'kreatif ajans', 'ik@alfaajans.example', 'Başvuruldu', 'Güçlü müşteri listesi', '']);
    s1.addRow(['Beta Film', 'https://www.betafilm.example/', 'Üsküdar', 'prodüksiyon', 'info@betafilm.example', '', '', 'Creative Director']);
    s1.addRow(['Gama Dijital', 'gamadijital.example', 'Ataşehir', 'dijital ajans', '', '', '', '']);
    s1.addRow(['Alfa Ajans', 'alfaajans.example', 'Kadıköy', '', '', '', 'tekrar satır', '']);
    s1.addRow(['', '', 'Şişli', '', '', '', 'Firma adı yok', 'Kreatif Direktör']);
    const s2 = wb.addWorksheet('Detay Rapor');
    s2.addRow(['Firma', 'Detay Rapor', 'Müşteriler']);
    s2.addRow(['Alfa Ajans', 'Son iki yılda tarihli film işleri var.', 'Marka A, Marka B']);
    s2.addRow(['Beta Film A.Ş.', 'Stüdyo ve post prodüksiyon ekibi.', '']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const preview = (await h.http().post('/api/v1/imports/excel').set(u.auth).attach('file', buf, 'firmalar.xlsx').expect(201)).body;
    expect(preview.sheets.map((s: any) => s.suggestedRole)).toEqual(['companies', 'details']);
    const sheets = preview.sheets.map((s: any) => ({ name: s.name, role: s.suggestedRole, mapping: s.suggestedMapping }));
    const dry = (await h.http().post(`/api/v1/imports/${preview.importId}/commit`).set(u.auth).send({ sheets, dryRun: true }).expect(201)).body;
    expect(dry.stats.companiesCreated).toBe(4);
    expect(await h.prisma.company.count({ where: { name: 'Gama Dijital' } })).toBe(0);
    const res = (await h.http().post(`/api/v1/imports/${preview.importId}/commit`).set(u.auth).send({ sheets, candidateId: u.candidate.id }).expect(201)).body;
    expect(res.stats).toMatchObject({ companiesCreated: 4, duplicatesInFile: 1, anonymous: 1, detailsLinked: 2, detailsUnmatched: 0, applicationsRecorded: 1, jobsRecorded: 2 });
    const ws = (await h.http().get('/api/v1/me').set(u.auth)).body.workspace.id;
    expect(await h.prisma.company.count({ where: { workspaceId: ws } })).toBe(4);
    const importedJobs = await h.prisma.job.findMany({ where: { workspaceId: ws } });
    expect(importedJobs.every((j) => j.status !== 'open')).toBe(true);
    const alfa = await h.prisma.company.findFirstOrThrow({ where: { workspaceId: ws, canonicalDomain: 'alfaajans.example' } });
    const contact = await h.prisma.contactPoint.findFirstOrThrow({ where: { companyId: alfa.id } });
    expect(contact.verifiedAt).toBeNull();
    // Geçmiş başvuru nedeniyle aynı ay içinde yeni niyet gönderimi engellenir
    await h.http().patch(`/api/v1/contacts/${contact.id}`).set(u.auth).send({ verified: true }).expect(200);
    const d = await createDraft(h, u, alfa.id, null, { intentType: 'general_intent' });
    const r = await h.http().post(`/api/v1/drafts/${d.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: 1 }).expect(409);
    expect(['ALREADY_APPLIED', 'COMPANY_COOLDOWN']).toContain(r.body.error.code);
  });

  it('CSV dışa aktarımında formül başlangıcı kaçırılır', async () => {
    const u = await setupUser(h, 'csv');
    await h.http().post('/api/v1/companies').set(u.auth).send({ name: '=HYPERLINK("http://x","tık")', sectors: [] }).expect(201);
    const r = await h.http().get('/api/v1/exports/companies?format=csv').set(u.auth).expect(200);
    expect(r.text).toContain(`'=HYPERLINK`);
  });
});
