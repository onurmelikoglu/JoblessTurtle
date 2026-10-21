import { AiService } from '../../src/engine/ai/ai.service';
import { InboxService } from '../../src/engine/inbox.service';
import { LearnedModelsService } from '../../src/engine/learned-models.service';
import { LetterService } from '../../src/engine/letter.service';
import { ResearchService } from '../../src/engine/research.service';
import { createDraft, createHarness, Harness, idem, resetDb, setupUser, User } from './harness';

let h: Harness;
let admin: User;
let guest: User;
let models: LearnedModelsService;
let research: ResearchService;
let serial = 0;

const DAY_MS = 86_400_000;
const workspaceOf = (u: User) => u.candidate.workspaceId as string;

interface SendSeed {
  count: number;
  delivered: number;
  replied?: number;
  ageDays?: number;
  features: Record<string, unknown>;
}

/** Deneyim defterine sonucu belli gönderimler yazar: ilk `delivered` tanesi ulaşmış, kalanı "adres bulunamadı" ile dönmüş. */
async function seedSends(workspaceId: string, seeds: SendSeed[]) {
  const data = seeds.flatMap((seed) =>
    Array.from({ length: seed.count }, (_, i) => {
      const delivered = i < seed.delivered;
      const replied = delivered && i < (seed.replied ?? 0);
      const createdAt = new Date(Date.now() - (seed.ageDays ?? 30) * DAY_MS - ++serial * 1000);
      return {
        workspaceId,
        kind: 'send',
        features: { intent: 'general_intent', hasJob: false, companyOrigin: 'discovery', ...seed.features },
        outcome: { category: replied ? 'human_reply' : delivered ? 'no_bounce' : 'bad_address', delivered, bounced: !delivered, replied, dead: !delivered },
        resolvedAt: createdAt,
        createdAt,
      };
    }),
  );
  await h.prisma.learningEvent.createMany({ data });
}

const address = (sourceType: string, patch: Record<string, unknown> = {}) => ({ kind: 'official_hr', local: 'strong_hr', domainMatch: true, sourceType, verified: false, ...patch });

async function firm(name: string, contacts: { email: string; sourceUrl: string; kind?: string }[]) {
  const domain = `${name}.example`;
  const company = (await h.http().post('/api/v1/companies').set(admin.auth).send({ name: `${name} ajans`, website: domain, sectors: ['kreatif ajans'], district: 'Kadıköy' }).expect(201)).body;
  for (const c of contacts) await h.prisma.contactPoint.create({ data: { workspaceId: workspaceOf(admin), companyId: company.id, email: c.email, kind: c.kind ?? 'official_hr', sourceUrl: c.sourceUrl } });
  await h.worker.drain();
  return company as { id: string; name: string };
}

async function opportunityOf(companyId: string) {
  const home = (await h.http().get('/api/v1/home/companies').set(admin.auth).expect(200)).body;
  return home.companies.find((c: any) => c.id === companyId).opportunities[0];
}

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  models = h.app.get(LearnedModelsService);
  research = h.app.get(ResearchService);
  admin = await setupUser(h, 'yonetici');
  guest = await setupUser(h, 'davetli');
  await h.worker.drain();
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('öğrenen sistem: veri azken', () => {
  it('modeller etkinleşmez ve hiçbir sıralamayı değiştirmez', async () => {
    await seedSends(workspaceOf(admin), [{ count: 12, delivered: 10, features: address('company_site') }]);
    const result = await models.train();
    expect(result.models.filter((m) => m.active)).toEqual([]);
    expect(await models.deliveryFor({ canonicalDomain: 'firma.example' })).toBeUndefined();
    expect(await models.opportunityRanker(workspaceOf(admin))).toBeNull();
    expect(await models.contactSearchHints()).toEqual([]);
    const overview = (await h.http().get('/api/v1/admin/learning').set(admin.auth).expect(200)).body;
    expect(overview.models.find((m: any) => m.name === 'delivery')).toMatchObject({ active: false, inactiveReason: 'few_samples', samples: 12 });
    const company = await firm('sessiz', [{ email: 'ik@sessiz.example', sourceUrl: 'https://sessiz.example/kariyer' }]);
    expect((await opportunityOf(company.id)).rank).toBeNull();
  });
});

describe('öğrenen sistem: teslim modeli', () => {
  beforeAll(async () => {
    await seedSends(workspaceOf(admin), [
      { count: 110, delivered: 104, features: address('company_site') },
      { count: 90, delivered: 80, features: address('careers_page') },
      { count: 90, delivered: 36, features: address('other_site', { domainMatch: false }) },
      { count: 50, delivered: 47, features: address('company_site', { kind: 'general', local: 'general' }) },
    ]);
    await models.train();
  });

  it('yeterli veriyle etkinleşir; ölçütleri ve en etkili özellikleri yönetici ekranına gelir', async () => {
    const overview = (await h.http().get('/api/v1/admin/learning').set(admin.auth).expect(200)).body;
    const delivery = overview.models.find((m: any) => m.name === 'delivery');
    expect(delivery).toMatchObject({ active: true, inactiveReason: null, samples: 352, label: 'Teslim: adres mail alıyor mu', scope: null });
    expect(delivery.gain).toBeGreaterThan(0.05);
    expect(delivery.auc).toBeGreaterThan(0.65);
    expect(delivery.effects[0]).toMatchObject({ feature: expect.stringMatching(/sourceType|domainMatch/) });
    expect(overview.events.find((e: any) => e.kind === 'send')).toMatchObject({ label: 'Gönderim', total: 352, resolved: 352 });
    expect(overview.weekly.reduce((n: number, w: any) => n + w.sent, 0)).toBeGreaterThan(300);
    expect(overview.weekly.some((w: any) => w.bounceRate > 0.1)).toBe(true);
    expect(overview.weekly.every((w: any) => w.pending === w.sent - w.delivered - w.bounced)).toBe(true);
    expect(overview.trainedAt).toEqual(expect.any(String));
  });

  it('üçüncü taraf sitede bulunan adrese düşük, firmanın kendi sayfasındakine yüksek olasılık verir', async () => {
    const delivery = (await models.deliveryFor({ canonicalDomain: 'firma.example', aliases: [] }))!;
    const own = delivery.of({ email: 'ik@firma.example', kind: 'official_hr', sourceUrl: 'https://firma.example/iletisim' });
    const careers = delivery.of({ email: 'kariyer@firma.example', kind: 'official_hr', sourceUrl: 'https://firma.example/kariyer' });
    const thirdParty = delivery.of({ email: 'cv@baskafirma.example', kind: 'official_hr', sourceUrl: 'https://rehber.example/firma' });
    expect(own).toBeGreaterThan(0.88);
    expect(careers).toBeGreaterThan(0.8);
    expect(thirdParty).toBeLessThan(0.55);
    expect(delivery.of({ email: 'cv@baskafirma.example', kind: 'official_hr', sourceUrl: 'https://rehber.example/firma', verifiedBy: 'delivery' })).toBe(0.98);
    expect(delivery.baseRate).toBeCloseTo(277 / 352, 2);
  });

  it('aynı türdeki adreslerden ulaşma olasılığı yüksek olan varsayılan alıcı olur', async () => {
    const company = await firm('siralama', [
      { email: 'ik@siralama.example', sourceUrl: 'https://rehber.example/siralama' },
      { email: 'kariyer@siralama.example', sourceUrl: 'https://siralama.example/kariyer' },
    ]);
    const opportunity = await opportunityOf(company.id);
    const preview = (await h.http().get(`/api/v1/home/preview/${opportunity.id}`).set(admin.auth).expect(200)).body;
    expect(preview.suggestedTo).toBe('kariyer@siralama.example');
    expect(preview.recipientOptions.map((o: any) => o.email)).toEqual(['kariyer@siralama.example', 'ik@siralama.example']);
    const draft = await createDraft(h, admin, company.id, null);
    const revision = await h.prisma.draftRevision.findFirstOrThrow({ where: { draftId: draft.id }, orderBy: { revision: 'desc' } });
    expect(revision.toEmail).toBe('kariyer@siralama.example');

    await h.prisma.keyValue.deleteMany({ where: { key: { startsWith: 'learning:model:' } } });
    (models as any).cache.clear();
    const without = (await h.http().get(`/api/v1/home/preview/${opportunity.id}`).set(admin.auth).expect(200)).body;
    expect(without.recipientOptions.map((o: any) => o.email)).toEqual(['ik@siralama.example', 'kariyer@siralama.example']);
    await models.train();
  });

  it('gönderim anındaki kestirim deneyim defterine yazılır', async () => {
    const company = await firm('kayitli', [{ email: 'kariyer@kayitli.example', sourceUrl: 'https://kayitli.example/kariyer' }]);
    const draft = await createDraft(h, admin, company.id, null);
    await h.prisma.keyValue.deleteMany({ where: { key: { startsWith: 'send:pace:' } } });
    const sent = await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(admin.auth).set('Idempotency-Key', idem()).send({ expectedRevision: draft.currentRevision }).expect(202);
    await h.worker.drain();
    const event = await h.prisma.learningEvent.findUniqueOrThrow({ where: { kind_attemptId: { kind: 'send', attemptId: sent.body.applicationId } } });
    const features = event.features as { pDeliver: number; sourceType: string };
    expect(features.sourceType).toBe('careers_page');
    expect(features.pDeliver).toBeGreaterThan(0.8);
    expect(features.pDeliver).toBeLessThan(1);
  });
});

describe('öğrenen sistem: istemlere eklenen deneyim', () => {
  it('adres araması, hangi kaynaktaki adreslerin ulaştığını ipucu olarak alır ve sonucu ipucuyla birlikte kaydedilir', async () => {
    const hints = await models.contactSearchHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('üçüncü taraf siteler %40 (90 gönderim)');
    const company = await firm('ipuclu', []);
    const ai = jest.spyOn(h.app.get(AiService), 'run').mockResolvedValue({ status: 'succeeded', output: { contacts: [{ email: 'ik@ipuclu.example', sourceUrl: 'https://ipuclu.example/kariyer', purpose: 'hr' }], offices: [] }, provider: 'cli_codex', taskId: 'fake-contacts', cached: false });
    await research.findDetails(company.id, null, { deep: true });
    expect(ai.mock.calls[0][0].input.hints).toEqual(hints);
    const event = await h.prisma.learningEvent.findFirstOrThrow({ where: { kind: 'contact_search', companyId: company.id } });
    expect(event.features).toMatchObject({ hints: true, depth: 'max' });
    await h.prisma.learningEvent.update({ where: { id: event.id }, data: { aiTaskId: 'fake-contacts' } });
    const overview = (await h.http().get('/api/v1/admin/learning').set(admin.auth).expect(200)).body;
    expect(overview.hints.contactSearch).toEqual(hints);
    expect(overview.promptVariants).toEqual([{ kind: 'contact_search', label: 'Adres araması (yeni gönderilebilir adres bulundu)', hints: true, runs: 1, successRate: 1 }]);
  });

  it('yazı hazırlanırken adayın yanıt almış başvurularındaki paragraflar örnek verilir; aynı firmanınki verilmez', async () => {
    const replied = await firm('yanitveren', [{ email: 'ik@yanitveren.example', sourceUrl: 'https://yanitveren.example/kariyer' }]);
    await h.prisma.aiTask.create({
      data: { workspaceId: workspaceOf(admin), kind: 'letter_company_line', provider: 'cli_claude', status: 'succeeded', inputHash: 'test', prompt: 'Firmaya özel iki paragraf yaz.', input: {}, output: { opening: 'Kampanya filmleriniz dikkatimi çekti.', connection: 'Benzer işlerde ekip yönettim.' }, entityType: 'Company', entityId: replied.id },
    });
    const draft = await createDraft(h, admin, replied.id, null);
    await h.prisma.keyValue.deleteMany({ where: { key: { startsWith: 'send:pace:' } } });
    const sent = await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(admin.auth).set('Idempotency-Key', idem()).send({ expectedRevision: draft.currentRevision }).expect(202);
    await h.worker.drain();
    const attemptId = sent.body.applicationId as string;
    await h.prisma.inboundMessage.create({ data: { workspaceId: workspaceOf(admin), attemptId, providerMessageId: 'test-reply-1', category: 'human_reply', classification: 'human_reply', source: 'imap', status: 'open' } });
    await (h.app.get(InboxService) as any).applyEffects({ id: attemptId }, 'human_reply', null);

    const other = await firm('yeniyazi', [{ email: 'ik@yeniyazi.example', sourceUrl: 'https://yeniyazi.example/kariyer' }]);
    const candidate = await h.prisma.candidateProfile.findUniqueOrThrow({ where: { id: admin.candidate.id } });
    const ai = jest.spyOn(h.app.get(AiService), 'run').mockImplementation(async (req) => ({
      status: 'succeeded',
      output: req.kind === 'letter_template' ? { body: 'Merhaba {firma} Ekibi,\n\n{firma_giris}\n\nDeneyimim.\n\n{firma_baglanti}\n\nİyi çalışmalar dilerim.' } : { opening: 'Açılış.', connection: 'Bağlantı.' },
      provider: 'cli_claude',
      taskId: `fake-${req.kind}`,
      cached: false,
    }));
    const letters = h.app.get(LetterService);
    await letters.compose({ candidate, company: await h.prisma.company.findUniqueOrThrow({ where: { id: other.id } }), intent: 'general_intent', jobTitle: null });
    const lineCall = ai.mock.calls.map((c) => c[0]).find((req) => req.kind === 'letter_company_line')!;
    expect(lineCall.input.provenExamples).toEqual([{ opening: 'Kampanya filmleriniz dikkatimi çekti.', connection: 'Benzer işlerde ekip yönettim.' }]);
    ai.mockClear();
    await letters.compose({ candidate, company: await h.prisma.company.findUniqueOrThrow({ where: { id: replied.id } }), intent: 'general_intent', jobTitle: null });
    expect(ai.mock.calls.map((c) => c[0]).find((req) => req.kind === 'letter_company_line')!.input.provenExamples).toBeUndefined();
  });
});

describe('öğrenen sistem: yanıt modeli ve fırsat sıralaması', () => {
  it('yanıt alan başvuruların özelliklerini öğrenir ve fırsatlara sıralama puanı verir', async () => {
    await seedSends(workspaceOf(admin), [
      { count: 150, delivered: 150, replied: 48, ageDays: 40, features: { ...address('company_site'), category: 'sector_target' } },
      { count: 150, delivered: 150, replied: 4, ageDays: 40, features: { ...address('company_site'), category: 'not_found' } },
      { count: 40, delivered: 40, replied: 0, ageDays: 3, features: { ...address('company_site'), category: 'not_found' } },
    ]);
    await models.train();
    const overview = (await h.http().get('/api/v1/admin/learning').set(admin.auth).expect(200)).body;
    const reply = overview.models.find((m: any) => m.name === 'reply');
    expect(reply).toMatchObject({ active: true });
    expect(reply.samples).toBeGreaterThanOrEqual(300);
    expect(reply.samples).toBeLessThan(700);
    const ranker = (await models.opportunityRanker(workspaceOf(admin)))!;
    const context = { intent: 'general_intent', kind: 'official_hr', hasJob: false, companyOrigin: 'discovery' };
    expect(ranker({ ...context, category: 'sector_target' })).toBeGreaterThan(ranker({ ...context, category: 'not_found' }) * 3);
    const home = (await h.http().get('/api/v1/home/companies').set(admin.auth).expect(200)).body;
    const ranks = home.companies.flatMap((c: any) => c.opportunities.map((o: any) => o.rank));
    expect(ranks.length).toBeGreaterThan(0);
    expect(ranks.every((r: number) => r > 0 && r < 1)).toBe(true);
    const potential = home.companies.filter((c: any) => c.class === 'potential' && c.matchingJobs === 0).map((c: any) => Math.max(...c.opportunities.map((o: any) => o.rank)));
    expect(potential).toEqual([...potential].sort((x, y) => y - x));
    expect(overview.models.filter((m: any) => m.name === 'interest').map((m: any) => m.scope).sort()).toEqual(['davetli çalışma alanı', 'yonetici çalışma alanı']);
  });
});

describe('öğrenen sistem: yönetici uçları', () => {
  it('veri seti JSONL olarak iner: istem, kabul edilmiş çıktı ve gerçek sonuç birlikte', async () => {
    const task = await h.prisma.aiTask.create({
      data: { workspaceId: workspaceOf(admin), kind: 'company_contacts', provider: 'cli_codex', model: 'gpt-6.1-sol', status: 'succeeded', inputHash: 'test', prompt: 'Firmanın başvuru adreslerini bul.', input: {}, output: { contacts: [{ email: 'ik@ornek.example' }] } },
    });
    await h.prisma.learningEvent.create({ data: { workspaceId: workspaceOf(admin), kind: 'contact_search', aiTaskId: task.id, features: { source: 'ai' }, outcome: { added: 1 }, resolvedAt: new Date() } });
    const res = await h.http().get('/api/v1/admin/learning/export').set(admin.auth).expect(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="jobless-turtle-veri-seti-\d{4}-\d{2}-\d{2}\.jsonl"/);
    const lines = res.text.trim().split('\n').map((line) => JSON.parse(line));
    const search = lines.find((l) => l.kind === 'contact_search');
    expect(search).toMatchObject({
      task: 'company_contacts',
      provider: 'cli_codex',
      model: 'gpt-6.1-sol',
      quality: 'good',
      outcome: { added: 1 },
      messages: [
        { role: 'user', content: 'Firmanın başvuru adreslerini bul.' },
        { role: 'assistant', content: '{"contacts":[{"email":"ik@ornek.example"}]}' },
      ],
    });
    const letter = lines.find((l) => l.kind === 'send');
    expect(letter).toMatchObject({ task: 'letter_company_line', quality: 'good', outcome: { replied: true } });
    expect(letter.messages[1].content).toContain('Kampanya filmleriniz');
  });

  it('yalnızca yönetici görebilir, indirebilir ve yeniden eğitebilir', async () => {
    for (const path of ['/api/v1/admin/learning', '/api/v1/admin/learning/export']) await h.http().get(path).set(guest.auth).expect(403);
    await h.http().post('/api/v1/admin/learning/train').set(guest.auth).expect(403);
    const retrained = (await h.http().post('/api/v1/admin/learning/train').set(admin.auth).expect(201)).body;
    expect(retrained.models.find((m: any) => m.name === 'delivery').active).toBe(true);
  });
});
