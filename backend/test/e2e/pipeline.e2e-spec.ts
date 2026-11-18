import { AiService } from '../../src/engine/ai/ai.service';
import { PipelineService } from '../../src/engine/pipeline.service';
import { createDraft, createHarness, Harness, idem, resetDb, setupCompanyWithJob, setupUser, User } from './harness';

let h: Harness;
let u: User;

const clearPacing = () => h.prisma.keyValue.deleteMany({ where: { key: { startsWith: 'send:pace:' } } });

async function sentApplication(name: string) {
  const { company } = await setupCompanyWithJob(h, u, { name, withJob: false });
  const draft = await createDraft(h, u, company.id, null, { intentType: 'general_intent' });
  await h.http().patch(`/api/v1/drafts/${draft.id}`).set(u.auth).send({ revision: draft.currentRevision, toEmail: `ik@${name.toLowerCase().replace(/\s+/g, '')}.example` }).expect(200);
  const fresh = await h.prisma.applicationDraft.findUniqueOrThrow({ where: { id: draft.id } });
  await clearPacing();
  const res = await h.http().post(`/api/v1/drafts/${fresh.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: fresh.currentRevision }).expect(202);
  await h.worker.drain();
  return h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: res.body.applicationId } });
}

const detail = async (id: string) => (await h.http().get(`/api/v1/home/applications/${id}`).set(u.auth).expect(200)).body;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  u = await setupUser(h, 'surec');
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('başvuru süreci ve mülâkatlar', () => {
  it('mülâkat eklenince aşama ve sonuç güncellenir; yaklaşanlarda ve takvim dosyasında görünür', async () => {
    const attempt = await sentApplication('Surec Ajans');
    const created = (await h.http().post(`/api/v1/home/applications/${attempt.id}/interviews`).set(u.auth).send({ startsAt: inDays(3), durationMin: 45, kind: 'video', link: 'https://meet.example/x' }).expect(201)).body;
    const d = await detail(attempt.id);
    expect(d.outcome).toBe('interview');
    expect(d.stages.map((s: any) => s.stage)).toEqual(['interview']);
    expect(d.interviews).toEqual([expect.objectContaining({ id: created.id, status: 'scheduled', kind: 'video', durationMin: 45 })]);
    const list = (await h.http().get('/api/v1/home/applications').set(u.auth).expect(200)).body.items.find((i: any) => i.id === attempt.id);
    expect(list).toMatchObject({ stage: 'interview', ghosted: false });
    expect(list.nextInterviewAt).toEqual(expect.any(String));
    const upcoming = (await h.http().get('/api/v1/home/interviews').set(u.auth).expect(200)).body;
    expect(upcoming).toEqual([expect.objectContaining({ id: created.id, company: expect.stringContaining('Surec Ajans') })]);
    const ics = await h.http().get(`/api/v1/home/interviews/${created.id}/ics`).set(u.auth).expect(200);
    expect(ics.headers['content-type']).toContain('text/calendar');
    expect(ics.text).toContain('BEGIN:VEVENT');
    expect((await h.app.get(PipelineService).sendReminders(new Date(Date.now() + 2.5 * 86_400_000))).sent).toBe(1);
    await h.http().patch(`/api/v1/home/interviews/${created.id}`).set(u.auth).send({ status: 'done' }).expect(200);
    expect((await h.http().get('/api/v1/home/interviews').set(u.auth).expect(200)).body).toEqual([]);
  });

  it('teklif aşaması sonucu teklif yapar; geçersiz aşama reddedilir', async () => {
    const attempt = await sentApplication('Teklif Ajans');
    await h.http().post(`/api/v1/home/applications/${attempt.id}/stages`).set(u.auth).send({ stage: 'offer', note: 'Maaş görüşülecek' }).expect(201);
    const d = await detail(attempt.id);
    expect(d.outcome).toBe('offer');
    expect(d.stages).toEqual([expect.objectContaining({ stage: 'offer', label: 'Teklif', note: 'Maaş görüşülecek', source: 'manual' })]);
    await h.http().post(`/api/v1/home/applications/${attempt.id}/stages`).set(u.auth).send({ stage: 'bilinmeyen' }).expect(400);
  });

  it('mülâkat davetinden çıkarılan tarih onay bekleyen öneri olur', async () => {
    const attempt = await sentApplication('Davet Ajans');
    const message = await h.prisma.inboundMessage.create({
      data: { workspaceId: attempt.workspaceId, attemptId: attempt.id, providerMessageId: `davet-${Date.now()}`, classification: 'interview', subject: 'Görüşme daveti', snippet: 'Perşembe 14:00 için Teams görüşmesi', source: 'test' },
    });
    const startsAt = inDays(4);
    jest.spyOn(h.app.get(AiService), 'run').mockResolvedValue({ status: 'succeeded', output: { startsAt, durationMin: 30, kind: 'video', link: 'https://teams.example/1', location: null, confidence: 0.9, note: null }, provider: 'cli_claude', taskId: 'davet', cached: false } as never);
    expect(await h.app.get(PipelineService).extractFromMessage(message.id)).toMatchObject({ status: 'proposed' });
    expect(await h.app.get(PipelineService).extractFromMessage(message.id)).toEqual({ status: 'exists' });
    const proposed = (await h.http().get('/api/v1/home/interviews').set(u.auth).expect(200)).body.find((i: any) => i.attemptId === attempt.id);
    expect(proposed).toMatchObject({ status: 'proposed', source: 'inbox', durationMin: 30 });
    expect(new Date(proposed.startsAt).toISOString()).toBe(startsAt);
    expect((await h.app.get(PipelineService).sendReminders(new Date(Date.now() + 3.5 * 86_400_000))).sent).toBe(0);
    await h.http().patch(`/api/v1/home/interviews/${proposed.id}`).set(u.auth).send({ status: 'scheduled' }).expect(200);
    expect((await h.app.get(PipelineService).sendReminders(new Date(Date.now() + 3.5 * 86_400_000))).sent).toBe(1);
  });

  it('istatistik hunisi gönderim, yanıt, mülâkat ve teklifleri sayar', async () => {
    const stats = (await h.http().get('/api/v1/home/stats?range=all').set(u.auth).expect(200)).body;
    const count = (key: string) => stats.funnel.find((f: any) => f.key === key).count;
    expect(count('sent')).toBe(3);
    expect(count('interview')).toBeGreaterThanOrEqual(2);
    expect(count('offer')).toBe(1);
    expect(stats.sendTime).toMatchObject({ suggestion: null, repliesNeeded: 30 });
    expect(stats.rates.map((r: any) => r.title)).toContain('Dile göre');
    await h.http().get('/api/v1/home/stats?range=7g').set(u.auth).expect(400);
  });
});
