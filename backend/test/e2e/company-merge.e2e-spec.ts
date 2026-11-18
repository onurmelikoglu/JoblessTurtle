import { CompanyMergeService } from '../../src/engine/company-merge.service';
import { createHarness, Harness, resetDb, setupUser, User } from './harness';

let h: Harness;
let u: User;

const TITLE = 'Dijital Pazarlama ve Sosyal Medya Uzmanı';

async function company(name: string, extra: Record<string, unknown> = {}) {
  return (await h.http().post('/api/v1/companies').set(u.auth).send({ name, sectors: ['yapı'], ...extra }).expect(201)).body as { id: string; name: string };
}

async function listing(companyId: string, title = TITLE, location = 'Körfez, Kocaeli') {
  const res = await h.http().post('/api/v1/jobs/manual').set(u.auth).send({ platform: 'manual', companyId, title, locationText: location, description: 'Sosyal medya hesaplarını yönetecek uzman.' }).expect(201);
  await h.worker.drain();
  return res.body;
}

const workspaceId = () => h.prisma.candidateProfile.findUniqueOrThrow({ where: { id: u.candidate.id } }).then((c) => c.workspaceId);

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  u = await setupUser(h, 'birlestir');
});

afterAll(async () => {
  await h.close();
});

describe('aynı firmanın kayıtları', () => {
  it('aynı ilanı taşıyan iki kayıt kendiliğinden birleşir; ilan ve fırsat teke iner, eski ad kalan kayda yönlenir', async () => {
    const short = await company('DURU TAŞ LTD ŞTİ');
    const long = await company('DURU TAŞ YAPI İNŞ. LTD. ŞTİ.', { district: 'Körfez', address: 'Çınar Mah. Deneme Sk. No: 9' });
    await listing(short.id);
    await listing(long.id);
    await h.prisma.contactPoint.create({ data: { workspaceId: await workspaceId(), companyId: short.id, email: 'info@durutas.example', kind: 'general' } });

    const twins = (await h.http().get('/api/v1/home/companies/twins').set(u.auth).expect(200)).body;
    expect(twins).toEqual([expect.objectContaining({ level: 'certain', reasons: expect.arrayContaining([expect.stringMatching(/^Aynı ilan/)]) })]);

    expect(await h.app.get(CompanyMergeService).autoMerge(await workspaceId())).toEqual({ merged: 1 });
    const [a, b] = await Promise.all([h.prisma.company.findUniqueOrThrow({ where: { id: short.id } }), h.prisma.company.findUniqueOrThrow({ where: { id: long.id } })]);
    const [kept, dropped] = a.mergedIntoId ? [b, a] : [a, b];
    expect(dropped).toMatchObject({ mergedIntoId: kept.id, excluded: true });
    expect(kept.aliases).toContain(dropped.name);

    const jobs = await h.prisma.job.findMany({ where: { companyId: { in: [short.id, long.id] } } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].companyId).toBe(kept.id);
    expect(await h.prisma.jobListing.count({ where: { jobId: jobs[0].id } })).toBe(2);
    expect(await h.prisma.contactPoint.count({ where: { companyId: kept.id } })).toBe(1);
    expect(await h.prisma.office.count({ where: { companyId: kept.id } })).toBeGreaterThanOrEqual(1);
    const opportunities = await h.prisma.opportunity.findMany({ where: { companyId: { in: [short.id, long.id] } } });
    expect(new Set(opportunities.map((o) => `${o.searchProfileId}|${o.key}`)).size).toBe(opportunities.length);
    expect(opportunities.every((o) => o.companyId === kept.id)).toBe(true);

    const home = (await h.http().get('/api/v1/home/companies').set(u.auth).expect(200)).body;
    expect(home.companies.filter((c: any) => c.name.startsWith('DURU TAŞ'))).toHaveLength(1);

    await h.http().post('/api/v1/jobs/manual').set(u.auth).send({ platform: 'manual', companyName: dropped.name, title: 'Muhasebe Uzmanı', locationText: 'Körfez, Kocaeli' }).expect(201);
    const newJob = await h.prisma.job.findFirstOrThrow({ where: { title: 'Muhasebe Uzmanı' } });
    expect(newJob.companyId).toBe(kept.id);
    expect((await h.http().get('/api/v1/home/companies/twins').set(u.auth).expect(200)).body).toEqual([]);
  });

  it('kanıtı olmayan benzer adlar yalnız öneridir; elle birleştirilir ya da "farklı firmalar" denir', async () => {
    const one = await company('Yeşil Vadi Gıda San. ve Tic. A.Ş.');
    const two = await company('YEŞİL VADİ TARIM LTD');
    const three = await company('Mavi Liman Lojistik');
    const four = await company('MAVİ LİMAN TAŞIMACILIK');
    const twins = (await h.http().get('/api/v1/home/companies/twins').set(u.auth).expect(200)).body;
    expect(twins.map((t: any) => t.level)).toEqual(['likely', 'likely']);
    expect(await h.app.get(CompanyMergeService).autoMerge(await workspaceId())).toEqual({ merged: 0 });

    await h.http().post('/api/v1/home/companies/merge').set(u.auth).send({ keepId: one.id, dropId: two.id }).expect(201);
    expect((await h.prisma.company.findUniqueOrThrow({ where: { id: two.id } })).mergedIntoId).toBe(one.id);
    await h.http().post('/api/v1/home/companies/merge').set(u.auth).send({ keepId: one.id, dropId: two.id }).expect(409);

    await h.http().post('/api/v1/home/companies/twins/dismiss').set(u.auth).send({ aId: three.id, bId: four.id }).expect(201);
    expect((await h.http().get('/api/v1/home/companies/twins').set(u.auth).expect(200)).body).toEqual([]);
  });

  it('adı gizli firmalar kaldırılır; başvurusu olan yalnızca gizlenir', async () => {
    const hidden = await company('Gizli Firma');
    const ws = await workspaceId();
    await h.prisma.job.create({ data: { workspaceId: ws, companyId: hidden.id, canonicalKey: `gizli:${hidden.id}`, title: 'Grafik Tasarımcı', normalizedTitle: 'grafik tasarimci' } });
    const described = await company('Sektöründe Lider Firma (gizli firma)');
    const applied = await company('Firma Adı Gizli');
    const draft = await h.prisma.applicationDraft.create({ data: { workspaceId: ws, candidateId: u.candidate.id, companyId: applied.id, intentType: 'general_intent' } });
    await h.prisma.applicationAttempt.create({ data: { workspaceId: ws, candidateId: u.candidate.id, companyId: applied.id, draftId: draft.id, draftRevision: 0, draftHash: 'x', idempotencyKey: `gizli-${Date.now()}`, requestHash: 'x', intentType: 'general_intent', sendMode: 'manual', channel: 'platform', state: 'provider_accepted' } });
    const real = await company('Gizli Bahçe Kafe');

    expect(await h.app.get(CompanyMergeService).removeHiddenCompanies(ws)).toEqual({ removed: 2, excluded: 1 });
    expect(await h.prisma.company.findUnique({ where: { id: hidden.id } })).toBeNull();
    expect(await h.prisma.company.findUnique({ where: { id: described.id } })).toBeNull();
    expect(await h.prisma.job.count({ where: { title: 'Grafik Tasarımcı' } })).toBe(0);
    expect(await h.prisma.company.findUniqueOrThrow({ where: { id: applied.id } })).toMatchObject({ excluded: true, excludedReason: 'Adı gizli firma' });
    expect((await h.prisma.company.findUniqueOrThrow({ where: { id: real.id } })).excluded).toBe(false);
    await h.http().post('/api/v1/jobs/manual').set(u.auth).send({ platform: 'manual', companyName: 'Firma Bilgisi Gizli', title: 'Muhasebeci', locationText: 'İstanbul' });
    await h.worker.drain();
    expect(await h.prisma.company.count({ where: { name: 'Firma Bilgisi Gizli' } })).toBe(0);
  });
});
