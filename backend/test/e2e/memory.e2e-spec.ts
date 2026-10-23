import { SourceConnector } from '@prisma/client';
import { AddressBookService } from '../../src/engine/address-book.service';
import { AiService } from '../../src/engine/ai/ai.service';
import { CatalogService } from '../../src/engine/catalog.service';
import { EvaluationService } from '../../src/engine/evaluation.service';
import { InboxService } from '../../src/engine/inbox.service';
import { IngestService } from '../../src/engine/ingest.service';
import { ResearchService } from '../../src/engine/research.service';
import { createDraft, createHarness, Harness, idem, resetDb, setupUser, User } from './harness';

let h: Harness;
let a: User;
let b: User;
let research: ResearchService;
let catalog: CatalogService;
let addressBook: AddressBookService;
let ingest: IngestService;

const DAY_MS = 86_400_000;
const TITLES = ['Kreatif Direktör', 'Creative Director'];

function discovered(name: string, domain: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    domain,
    district: 'Kadıköy',
    sectors: ['kreatif ajans'],
    reason: 'Kreatif ekibini büyütüyor',
    sourceUrl: `https://${domain}/hakkimizda`,
    signal: 'sector_fit',
    careersUrl: `https://${domain}/kariyer`,
    hrEmail: `kariyer@${domain}`,
    hrEmailSource: `https://${domain}/kariyer`,
    officeAddress: 'Caferağa Mah. Moda Cad. No:1',
    officeCity: 'İstanbul',
    officeSource: `https://${domain}/iletisim`,
    ...extra,
  };
}

const workspaceOf = (u: User): string => u.candidate.workspaceId;

function companyOf(u: User, domain: string) {
  return h.prisma.company.findFirstOrThrow({ where: { workspaceId: workspaceOf(u), canonicalDomain: domain }, include: { contacts: true, offices: true, sources: true, jobs: true } });
}

const contactOf = (u: User, domain: string, email: string) => companyOf(u, domain).then((c) => c.contacts.find((x) => x.email === email));

async function draftFor(u: User, companyId: string, toEmail?: string) {
  const draft = await createDraft(h, u, companyId, null);
  if (toEmail) await h.http().patch(`/api/v1/drafts/${draft.id}`).set(u.auth).send({ revision: draft.currentRevision, toEmail }).expect(200);
  return h.prisma.applicationDraft.findUniqueOrThrow({ where: { id: draft.id } });
}

/** Aynı hesaptan art arda gönderimler arasındaki bekleme testte kaldırılır. */
async function send(u: User, domain: string, toEmail?: string) {
  const draft = await draftFor(u, (await companyOf(u, domain)).id, toEmail);
  await h.prisma.keyValue.deleteMany({ where: { key: { startsWith: 'send:pace:' } } });
  const res = await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: draft.currentRevision }).expect(202);
  await h.worker.drain();
  const attempt = await h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: res.body.applicationId } });
  expect(attempt.state).toBe('provider_accepted');
  return attempt;
}

const sendEventOf = (attemptId: string) => h.prisma.learningEvent.findUniqueOrThrow({ where: { kind_attemptId: { kind: 'send', attemptId } } });

function aiAnswers(output: (input: any) => unknown) {
  return jest.spyOn(h.app.get(AiService), 'run').mockImplementation(async (req) => ({ status: 'succeeded', output: output(req.input), provider: 'cli_codex', taskId: `fake-${req.kind}`, cached: false }));
}

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  research = h.app.get(ResearchService);
  catalog = h.app.get(CatalogService);
  addressBook = h.app.get(AddressBookService);
  ingest = h.app.get(IngestService);
  a = await setupUser(h, 'ayse');
  await research.applyDiscovery(
    workspaceOf(a),
    {
      companies: [
        discovered('Ortak Ajans', 'ortakajans.example', { employees: '51-200' }),
        discovered('Ankara Ajans', 'ankaraajans.example', { district: null, officeCity: 'Ankara', officeAddress: 'Kızılay Mah. Atatürk Bulvarı No:5' }),
        discovered('Silinen Ajans', 'silinenajans.example'),
        discovered('İkiz Ajans', 'ikizajans.example', { hrEmail: null, hrEmailSource: null }),
        discovered('Teslim Ajans', 'teslimajans.example', { hrEmail: 'info@teslimajans.example', hrEmailSource: 'https://teslimajans.example/iletisim' }),
        discovered('Kapalı Ajans', 'kapaliajans.example'),
      ],
    },
    'kesif-1',
    { titles: TITLES },
  );
  await h.worker.drain();
  const ortak = await companyOf(a, 'ortakajans.example');
  await h.prisma.job.create({
    data: { workspaceId: workspaceOf(a), companyId: ortak.id, canonicalKey: 'test:gecmis-ilan', title: 'Kreatif Direktör', normalizedTitle: 'creative director', status: 'closed', firstSeenAt: new Date('2026-06-01'), lastSeenAt: new Date('2026-07-30'), closedAt: new Date('2026-08-01') },
  });
  await h.app.get(EvaluationService).evaluateCompany(ortak.id);
  b = await setupUser(h, 'burak');
  await h.worker.drain();
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ortak katalog: arkadaş hesabı aramadan firma görür', () => {
  it('profil kaydedilince kriterlere uyan firmalar adres, ofis, kaynak ve geçmiş ilanla birlikte gelir', async () => {
    const companies = await h.prisma.company.findMany({ where: { workspaceId: workspaceOf(b) }, select: { canonicalDomain: true }, orderBy: { canonicalDomain: 'asc' } });
    expect(companies.map((c) => c.canonicalDomain)).toEqual(['ikizajans.example', 'kapaliajans.example', 'ortakajans.example', 'silinenajans.example', 'teslimajans.example']);
    const ortak = await companyOf(b, 'ortakajans.example');
    expect(ortak).toMatchObject({ origin: 'catalog', employeeRange: '51-200', notes: null, careersUrl: 'https://ortakajans.example/kariyer' });
    expect(ortak.catalogId).toBe((await companyOf(a, 'ortakajans.example')).catalogId);
    expect(ortak.contacts.map((c) => [c.email, c.kind, c.suppressed])).toEqual([['kariyer@ortakajans.example', 'official_hr', false]]);
    expect(ortak.offices.map((o) => [o.city, o.district])).toEqual([['İstanbul', 'Kadıköy']]);
    expect(ortak.sources.map((s) => s.kind)).toEqual(['career_page']);
    expect(ortak.jobs.map((j) => [j.title, j.status, j.statusReason])).toEqual([['Kreatif Direktör', 'closed', 'catalog_history']]);
  });

  it('eklenen firmalar için yapay zekâ çağrısı yapılmaz ve kullanıcıya bildirilir', async () => {
    expect(await h.prisma.aiTask.count({ where: { workspaceId: workspaceOf(b), kind: { in: ['company_report', 'company_contacts', 'company_sizes'] } } })).toBe(0);
    const notes = (await h.http().get('/api/v1/notifications').set(b.auth).expect(200)).body.items;
    expect(notes.find((n: any) => n.type === 'catalog_seed').title).toBe('5 firma ortak listeden eklendi');
  });

  it('geçmişte ilan açmış firma kendi sınıfında ve çalışan sayısıyla listelenir', async () => {
    const home = (await h.http().get('/api/v1/home/companies').set(b.auth).expect(200)).body;
    const ortak = home.companies.find((c: any) => c.name === 'Ortak Ajans');
    expect(ortak).toMatchObject({ class: 'past', employees: { range: '51-200', count: null } });
    expect(home.totals.sizeUnknown).toBe(home.companies.length - 1);
  });

  it('başka şehirdeki firma önerilmez; A\'nın notları ve başvuruları katalogda yer almaz', async () => {
    expect(await h.prisma.company.count({ where: { workspaceId: workspaceOf(b), canonicalDomain: 'ankaraajans.example' } })).toBe(0);
    const row = await h.prisma.catalogCompany.findUniqueOrThrow({ where: { key: 'ortakajans.example' } });
    expect(row.discoveredFor).toEqual(['creative director']);
    expect(JSON.stringify(row)).not.toContain('Kreatif ekibini büyütüyor');
  });

  it('kullanıcının sildiği firma yeniden önerilmez', async () => {
    const silinen = await companyOf(b, 'silinenajans.example');
    await h.http().delete(`/api/v1/companies/${silinen.id}`).set(b.auth).expect(200);
    expect(await catalog.seedWorkspace(b.profile.id)).toEqual({ matched: 0, created: 0 });
  });
});

describe('ortak katalog: bulunan adres ve çalışan sayısı paylaşılır', () => {
  it('başka bir çalışma alanında bulunan adres yapay zekâya sorulmadan gelir', async () => {
    const mine = await companyOf(a, 'ikizajans.example');
    await ingest.saveContacts({ companyId: mine.id } as SourceConnector, [{ email: 'ik@ikizajans.example', sourceUrl: 'https://ikizajans.example/kariyer' }], 'cli_codex');
    await catalog.publish(mine.id);
    const ai = jest.spyOn(h.app.get(AiService), 'run');
    const theirs = await companyOf(b, 'ikizajans.example');
    expect(await research.findDetails(theirs.id, null, { deep: true, force: true })).toEqual({ status: 'succeeded', source: 'catalog' });
    expect(ai).not.toHaveBeenCalled();
    expect((await companyOf(b, 'ikizajans.example')).contacts.map((c) => c.email)).toEqual(['ik@ikizajans.example']);
    const event = await h.prisma.learningEvent.findFirstOrThrow({ where: { kind: 'contact_search', companyId: theirs.id } });
    expect(event).toMatchObject({ features: { source: 'catalog', deep: true }, outcome: { added: 1 } });
  });

  it('katalogda yenisi yoksa arama yapılır; bulunan adres ve çalışan sayısı diğer çalışma alanına da ulaşır', async () => {
    const ai = aiAnswers(() => ({ contacts: [{ email: 'kariyer@ikizajans.example', sourceUrl: 'https://ikizajans.example/iletisim', purpose: 'hr' }], offices: [], employees: '11-50 çalışan' }));
    const theirs = await companyOf(b, 'ikizajans.example');
    expect(await research.findDetails(theirs.id, null, { force: true })).toMatchObject({ status: 'succeeded', source: 'ai' });
    expect(ai).toHaveBeenCalledTimes(1);
    expect((await companyOf(b, 'ikizajans.example')).employeeRange).toBe('11-50');
    const mine = await companyOf(a, 'ikizajans.example');
    expect(await catalog.pull(mine.id)).toEqual({ contacts: 1, offices: 0, size: true });
    const refreshed = await companyOf(a, 'ikizajans.example');
    expect(refreshed.employeeRange).toBe('11-50');
    expect(refreshed.contacts.map((c) => c.email).sort()).toEqual(['ik@ikizajans.example', 'kariyer@ikizajans.example']);
    expect(await h.prisma.addressRecord.findUniqueOrThrow({ where: { email: 'kariyer@ikizajans.example' } })).toMatchObject({ foundBy: 'cli_codex', sourceType: 'company_site' });
  });

  it('çalışan sayısı araması: sıraya alınır, bulunan değer kataloğa yazılır, diğer çalışma alanı aramadan alır', async () => {
    const ai = aiAnswers((input) => ({ sizes: input.companies.map((c: any) => ({ ref: c.ref, employees: c.name === 'Teslim Ajans' ? '1.001-5.000' : null, linkedinUrl: c.name === 'Teslim Ajans' ? 'https://www.linkedin.com/company/teslim-ajans' : 'javascript:alert(1)' })) }));
    const queued = (await h.http().post('/api/v1/home/companies/sizes').set(b.auth).expect(201)).body;
    expect(queued).toEqual({ queued: 2, remaining: 0 });
    await h.worker.drain();
    expect(ai).toHaveBeenCalledTimes(1);
    expect(await companyOf(b, 'teslimajans.example')).toMatchObject({ employeeRange: '1001-5000', employeeCount: null, linkedinUrl: 'https://www.linkedin.com/company/teslim-ajans' });
    expect(await companyOf(b, 'kapaliajans.example')).toMatchObject({ employeeRange: null, linkedinUrl: null });
    expect((await h.http().post('/api/v1/home/companies/sizes').set(b.auth).expect(201)).body).toEqual({ queued: 0, remaining: 0 });
    ai.mockClear();
    const mine = await companyOf(a, 'teslimajans.example');
    expect(await research.findSizes(workspaceOf(a), [mine.id])).toMatchObject({ asked: 0, fromCatalog: 1 });
    expect(ai).not.toHaveBeenCalled();
    expect((await companyOf(a, 'teslimajans.example')).employeeRange).toBe('1001-5000');
  });
});

describe('gece turu: önce ortak hafıza, sonra arama', () => {
  it('katalogdaki yeni bilgi alınır, uyan yeni firmalar eklenir, çalışan sayısı bilinmeyenler gruplar halinde sıraya girer', async () => {
    const worker = h.worker as any;
    await research.applyDiscovery(workspaceOf(a), { companies: [discovered('Gece Ajans', 'geceajans.example', { employees: '11-50' })] }, 'kesif-gece', { titles: TITLES });
    await h.worker.drain();
    worker.inline.length = 0;
    await worker.dailyDiscovery(new Date());
    const queued = worker.inline.splice(0);
    const queuedFor = (name: string, u: User) => queued.filter((j: any) => j.name === name && j.data.workspaceId === workspaceOf(u));
    expect(queuedFor('catalog_refresh', b).map((j: any) => j.data.seed)).toEqual([true]);
    expect(queuedFor('company_sizes', a).map((j: any) => j.data.companyIds.length)).toEqual([3]);
    expect(queuedFor('company_sizes', b)).toEqual([]);
    expect(await h.worker.handle('research', { name: 'catalog_refresh', data: { workspaceId: workspaceOf(b), seed: true } } as any)).toMatchObject({ created: 1 });
    expect(await companyOf(b, 'geceajans.example')).toMatchObject({ origin: 'catalog', employeeRange: '11-50' });
  });

  it('arama durdurulmuşsa profil değişikliği ortak listeden firma eklemez', async () => {
    await research.applyDiscovery(workspaceOf(a), { companies: [discovered('Duraklı Ajans', 'durakliajans.example')] }, 'kesif-durakli', { titles: TITLES });
    await h.worker.drain();
    await h.http().post('/api/v1/home/search/stop').set(b.auth).expect(201);
    const profile = await h.prisma.searchProfile.findUniqueOrThrow({ where: { id: b.profile.id } });
    await h.http().patch(`/api/v1/search-profiles/${profile.id}`).set(b.auth).send({ revision: profile.revision, keywords: ['kampanya'] }).expect(200);
    await h.worker.drain();
    expect(await h.prisma.company.count({ where: { workspaceId: workspaceOf(b), canonicalDomain: 'durakliajans.example' } })).toBe(0);
    await research.setPaused(workspaceOf(b), false);
    expect(await catalog.seedWorkspace(b.profile.id)).toEqual({ matched: 1, created: 1 });
  });
});

describe('adres sicili: geçersiz adres bir daha seçilemez', () => {
  const DEAD = 'kariyer@ortakajans.example';
  let attemptId: string;

  beforeAll(async () => {
    const theirs = await companyOf(b, 'ortakajans.example');
    await h.prisma.job.create({ data: { workspaceId: workspaceOf(b), companyId: theirs.id, canonicalKey: 'test:basvuru-adresli', title: 'Art Director', normalizedTitle: 'art director', status: 'open', applyEmail: DEAD, channel: 'email' } });
    attemptId = (await send(a, 'ortakajans.example')).id;
  });

  it('gönderim sicile ve deneyim defterine özellikleriyle işlenir', async () => {
    expect(await h.prisma.addressRecord.findUniqueOrThrow({ where: { email: DEAD } })).toMatchObject({ sent: 1, delivered: 0, bounced: 0, status: 'unknown', sourceType: 'careers_page' });
    const event = await sendEventOf(attemptId);
    expect(event).toMatchObject({ workspaceId: workspaceOf(a), outcome: null, resolvedAt: null, features: { kind: 'official_hr', local: 'strong_hr', domainMatch: true, sourceType: 'careers_page', intent: 'general_intent', sendMode: 'manual', employeeRange: '51-200', attachments: 1 } });
    await addressBook.noteSent(attemptId);
    expect((await h.prisma.addressRecord.findUniqueOrThrow({ where: { email: DEAD } })).sent).toBe(1);
  });

  it('"adres bulunamadı" dönüşü adresi tüm çalışma alanlarında kalıcı olarak kapatır', async () => {
    await (h.app.get(InboxService) as any).applyEffects({ id: attemptId }, 'bad_address', null);
    expect((await h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: attemptId } })).state).toBe('bounced');
    expect(await h.prisma.addressRecord.findUniqueOrThrow({ where: { email: DEAD } })).toMatchObject({ status: 'dead', bounced: 1, deadReason: 'bad_address' });
    expect(await sendEventOf(attemptId)).toMatchObject({ outcome: { category: 'bad_address', bounced: true, delivered: false, dead: true } });
    expect((await contactOf(a, 'ortakajans.example', DEAD))?.suppressed).toBe(true);
    expect((await contactOf(b, 'ortakajans.example', DEAD))?.suppressed).toBe(true);
    expect((await h.prisma.job.findFirstOrThrow({ where: { canonicalKey: 'test:basvuru-adresli' } })).applyEmail).toBeNull();
  });

  it('kullanıcı aynı adresi elle seçemez, ekleyemez, yeniden açamaz', async () => {
    const resend = await h.http().post(`/api/v1/home/applications/${attemptId}/resend`).set(a.auth).send({ toEmail: DEAD, subject: 'Açık Başvuru', body: 'Merhaba, başvurumu yeniden iletiyorum. İyi çalışmalar.' }).expect(422);
    expect(resend.body.error.code).toBe('SUPPRESSED');
    const theirs = await companyOf(b, 'ortakajans.example');
    const contact = theirs.contacts.find((c) => c.email === DEAD)!;
    expect((await h.http().patch(`/api/v1/contacts/${contact.id}`).set(b.auth).send({ suppressed: false }).expect(422)).body.error.code).toBe('DEAD_ADDRESS');
    const other = await companyOf(b, 'teslimajans.example');
    expect((await h.http().post(`/api/v1/companies/${other.id}/contacts`).set(b.auth).send({ email: DEAD }).expect(422)).body.error.code).toBe('DEAD_ADDRESS');
    const draft = await draftFor(b, other.id, DEAD);
    const sendAttempt = await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(b.auth).set('Idempotency-Key', idem()).send({ expectedRevision: draft.currentRevision }).expect(422);
    expect(sendAttempt.body.error.code).toBe('DEAD_ADDRESS');
  });

  it('adres yeniden bulunsa da kaydedilmez; sonraki arama bu adresin dışındakileri ister', async () => {
    const theirs = await companyOf(b, 'ortakajans.example');
    const ai = aiAnswers(() => ({ contacts: [{ email: DEAD, sourceUrl: 'https://ortakajans.example/kariyer', purpose: 'hr' }, { email: 'ik@ortakajans.example', sourceUrl: 'https://ortakajans.example/kariyer', purpose: 'hr' }], offices: [] }));
    await research.findDetails(theirs.id, null, { force: true });
    expect(ai.mock.calls[0][0].input.avoidEmails).toEqual([DEAD]);
    const contacts = (await companyOf(b, 'ortakajans.example')).contacts;
    expect(contacts.filter((c) => !c.suppressed).map((c) => c.email)).toEqual(['ik@ortakajans.example']);
    expect(contacts.filter((c) => c.email === DEAD)).toHaveLength(1);
    const row = await h.prisma.catalogCompany.findUniqueOrThrow({ where: { key: 'ortakajans.example' } });
    expect((row.contacts as { email: string }[]).map((c) => c.email)).toEqual(['ik@ortakajans.example']);
  });

  it('yeni açılan hesap geçersiz adresi hiç görmez', async () => {
    const c = await setupUser(h, 'cem');
    await h.worker.drain();
    expect((await companyOf(c, 'ortakajans.example')).contacts.map((x) => x.email)).toEqual(['ik@ortakajans.example']);
  });

  it('alan adı mail almıyorsa o alan adındaki tüm adresler kapanır; ücretsiz posta sağlayıcısı topluca kapatılmaz', async () => {
    const theirs = await companyOf(b, 'kapaliajans.example');
    await ingest.saveContacts({ companyId: theirs.id } as SourceConnector, [{ email: 'info@kapaliajans.example', sourceUrl: 'https://kapaliajans.example/iletisim' }]);
    const attempt = await send(a, 'kapaliajans.example');
    await addressBook.noteOutcome(attempt.id, 'bad_domain');
    expect(await h.prisma.deadDomain.findUnique({ where: { domain: 'kapaliajans.example' } })).toMatchObject({ reason: 'bad_domain' });
    expect((await companyOf(b, 'kapaliajans.example')).contacts.map((c) => [c.email, c.suppressed]).sort()).toEqual([['info@kapaliajans.example', true], ['kariyer@kapaliajans.example', true]]);
    expect(await addressBook.isDead('yeni@kapaliajans.example')).toBe(true);
    await addressBook.markDomainDead('gmail.com', 'yanlis@gmail.com', 'bad_domain');
    expect(await addressBook.isDead('yanlis@gmail.com')).toBe(true);
    expect(await addressBook.isDead('baska@gmail.com')).toBe(false);
  });
});

describe('adres sicili: ulaşan adres bilinir', () => {
  const REACHED = 'info@teslimajans.example';
  let attemptId: string;

  beforeAll(async () => {
    attemptId = (await send(a, 'teslimajans.example')).id;
  });

  it('otomatik yanıt adresi "ulaşıyor" yapar ve diğer çalışma alanında doğrulanmış sayılır', async () => {
    expect(await contactOf(b, 'teslimajans.example', REACHED)).toMatchObject({ verifiedAt: null, kind: 'general' });
    await addressBook.noteOutcome(attemptId, 'auto_reply');
    expect(await h.prisma.addressRecord.findUniqueOrThrow({ where: { email: REACHED } })).toMatchObject({ status: 'deliverable', sent: 1, delivered: 1, replied: 0 });
    expect(await contactOf(b, 'teslimajans.example', REACHED)).toMatchObject({ verifiedBy: 'delivery' });
    const home = (await h.http().get('/api/v1/home/companies').set(b.auth).expect(200)).body;
    const opportunityId = home.companies.find((c: any) => c.name === 'Teslim Ajans').opportunities[0].id;
    const preview = (await h.http().get(`/api/v1/home/preview/${opportunityId}`).set(b.auth).expect(200)).body;
    expect(preview.recipientOptions).toEqual([expect.objectContaining({ email: REACHED, delivered: true, verified: true })]);
  });

  it('aynı başvuruya gelen ikinci dönüş sayaçları iki kez artırmaz', async () => {
    await addressBook.noteOutcome(attemptId, 'human_reply');
    await addressBook.noteOutcome(attemptId, 'auto_reply');
    expect(await h.prisma.addressRecord.findUniqueOrThrow({ where: { email: REACHED } })).toMatchObject({ delivered: 1, replied: 1, bounced: 0 });
    expect((await sendEventOf(attemptId)).outcome).toMatchObject({ category: 'human_reply', delivered: true, replied: true });
  });

  it('gelen kutusu izlenen hesapta 72 saat geri dönmeyen mail ulaşmış sayılır; geç gelen geri dönme bunu düzeltir', async () => {
    const attempt = await send(a, 'ikizajans.example', 'ik@ikizajans.example');
    const sentAt = new Date(Date.now() - 4 * DAY_MS);
    await h.prisma.learningEvent.update({ where: { kind_attemptId: { kind: 'send', attemptId: attempt.id } }, data: { createdAt: sentAt } });
    expect(await addressBook.settle()).toEqual({ settled: 0 });
    await h.prisma.mailAccount.update({ where: { id: a.account.id }, data: { provider: 'smtp', smtpHost: 'smtp.test.local', encryptedSecret: 'x', inboxSyncedAt: new Date() } });
    try {
      expect(await addressBook.settle()).toEqual({ settled: 1 });
    } finally {
      await h.prisma.mailAccount.update({ where: { id: a.account.id }, data: { provider: 'fake', smtpHost: null, encryptedSecret: null } });
    }
    expect((await sendEventOf(attempt.id)).outcome).toMatchObject({ category: 'no_bounce', delivered: true });
    expect(await h.prisma.addressRecord.findUniqueOrThrow({ where: { email: 'ik@ikizajans.example' } })).toMatchObject({ status: 'deliverable', delivered: 1 });
    await addressBook.noteOutcome(attempt.id, 'bad_address');
    expect(await h.prisma.addressRecord.findUniqueOrThrow({ where: { email: 'ik@ikizajans.example' } })).toMatchObject({ status: 'dead', delivered: 0, bounced: 1 });
    expect((await sendEventOf(attempt.id)).outcome).toMatchObject({ category: 'bad_address', delivered: false, bounced: true, dead: true });
  });

  it('gelen kutusu izlenemeyen hesapta sonuç "gözlenemedi" olarak kapanır ve sicile işlenmez', async () => {
    const attempt = await send(a, 'silinenajans.example');
    await h.prisma.learningEvent.update({ where: { kind_attemptId: { kind: 'send', attemptId: attempt.id } }, data: { createdAt: new Date(Date.now() - 20 * DAY_MS) } });
    expect(await addressBook.settle()).toEqual({ settled: 1 });
    expect((await sendEventOf(attempt.id)).outcome).toMatchObject({ category: 'unobserved', delivered: false });
    expect(await h.prisma.addressRecord.findUniqueOrThrow({ where: { email: 'kariyer@silinenajans.example' } })).toMatchObject({ status: 'unknown', delivered: 0, sent: 1 });
  });
});

describe('var olan verinin ortak hafızaya taşınması', () => {
  it('firmalar kataloğa, gönderimler ve dönüşleri sicile işlenir; ikinci çalıştırma bir şey yapmaz', async () => {
    const bounced = await h.prisma.applicationAttempt.findFirstOrThrow({ where: { toEmail: 'kariyer@ortakajans.example' } });
    await h.prisma.inboundMessage.create({ data: { workspaceId: bounced.workspaceId, attemptId: bounced.id, providerMessageId: 'test-bounce-1', category: 'bad_address', classification: 'bounce', source: 'imap' } });
    await h.prisma.contactPoint.updateMany({ where: { email: 'kariyer@ortakajans.example', workspaceId: workspaceOf(b) }, data: { suppressed: false } });
    await h.prisma.$transaction([
      h.prisma.learningEvent.deleteMany(),
      h.prisma.addressRecord.deleteMany(),
      h.prisma.deadDomain.deleteMany(),
      h.prisma.company.updateMany({ data: { catalogId: null } }),
      h.prisma.catalogCompany.deleteMany(),
    ]);
    expect(await catalog.backfilled()).toBe(false);
    const sends = await h.prisma.applicationAttempt.count({ where: { channel: 'email', state: { in: ['provider_accepted', 'bounced', 'replied'] } } });
    const summary = await catalog.backfill();
    expect(summary).toMatchObject({ sends });
    expect(await h.prisma.catalogCompany.count()).toBe(8);
    expect(await h.prisma.company.count({ where: { catalogId: null } })).toBe(0);
    expect((await h.prisma.catalogCompany.findUniqueOrThrow({ where: { key: 'ankaraajans.example' } })).discoveredFor).toEqual(['creative director', 'head of creative', 'art director']);
    expect(await h.prisma.learningEvent.count({ where: { kind: 'send' } })).toBe(sends);
    expect(await h.prisma.addressRecord.findUniqueOrThrow({ where: { email: 'kariyer@ortakajans.example' } })).toMatchObject({ status: 'dead', sent: 1, bounced: 1 });
    expect((await contactOf(b, 'ortakajans.example', 'kariyer@ortakajans.example'))?.suppressed).toBe(true);
    expect(await catalog.backfill()).toEqual({ skipped: true });
  });
});
