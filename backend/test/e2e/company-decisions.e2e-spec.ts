import { JobSearchService } from '../../src/engine/job-search.service';
import { ResearchService } from '../../src/engine/research.service';
import { createHarness, Harness, resetDb, setupCompanyWithJob, setupUser, User } from './harness';

let h: Harness;
let u: User;

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  u = await setupUser(h, 'decide');
});

afterAll(async () => {
  await h.close();
});

const workspaceId = () => u.candidate.workspaceId;
const listing = (company: string, slug: string, title = 'Kreatif Direktör') => ({ title, company, url: `https://ilan.example/${slug}`, location: 'Kadıköy, İstanbul' });

async function apply(listings: ReturnType<typeof listing>[], taskId: string) {
  const profile = await h.prisma.searchProfile.findUniqueOrThrow({ where: { id: u.profile.id } });
  const stats = await h.app.get(JobSearchService).applyListings(profile, listings, taskId, { announced: true });
  await h.worker.drain();
  return stats;
}

describe('benzer adlı firma kararı', () => {
  let stone: { id: string };

  beforeAll(async () => {
    stone = (await setupCompanyWithJob(h, u, { name: 'ORNEKTAS STONE LTD ŞTİ', withJob: false })).company;
  });

  it('benzer adlı yeni firmanın ilanı bekletilir, firma açılmaz, karar bildirimi gider', async () => {
    const stats = await apply([listing('Ornektas Stone Yapı', 'stone-1')], 'test-decide-1');
    expect(stats.deferred).toBe(1);
    expect(stats.newCompanies).toBe(0);
    expect(await h.prisma.company.count({ where: { workspaceId: workspaceId(), normalizedName: { contains: 'ornektas stone yapi' } } })).toBe(0);
    const decisions = (await h.http().get('/api/v1/home/company-decisions').set(u.auth).expect(200)).body;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ name: 'Ornektas Stone Yapı', listingCount: 1, titles: ['Kreatif Direktör'], suggested: { id: stone.id } });
    expect(await h.prisma.notification.count({ where: { workspaceId: workspaceId(), type: 'company_decision' } })).toBe(1);
    expect(await h.prisma.notification.count({ where: { workspaceId: workspaceId(), type: 'new_jobs' } })).toBe(0);
  });

  it('aynı ad tekrar gelince ilanlar aynı kararda birikir', async () => {
    await apply([listing('Ornektas Stone Yapı', 'stone-2', 'Creative Director')], 'test-decide-2');
    const rows = await h.prisma.companyDecision.findMany({ where: { workspaceId: workspaceId() } });
    expect(rows).toHaveLength(1);
    expect(rows[0].listingCount).toBe(2);
  });

  it('"bu firmaya ekle": ilanlar kayıtlı firmaya eklenir, ad bir daha sorulmaz', async () => {
    const [decision] = (await h.http().get('/api/v1/home/company-decisions').set(u.auth).expect(200)).body;
    await h.http().post(`/api/v1/home/company-decisions/${decision.id}`).set(u.auth).send({ action: 'merge' }).expect(201);
    await h.worker.drain();
    expect(await h.prisma.jobListing.count({ where: { job: { companyId: stone.id } } })).toBe(2);
    const kept = await h.prisma.company.findUniqueOrThrow({ where: { id: stone.id } });
    expect(kept.aliases).toContain('Ornektas Stone Yapı');

    const stats = await apply([listing('Ornektas Stone Yapı', 'stone-3', 'Art Director')], 'test-decide-3');
    expect(stats.deferred).toBe(0);
    expect(await h.prisma.companyDecision.count({ where: { workspaceId: workspaceId(), status: 'pending' } })).toBe(0);
    expect(await h.prisma.jobListing.count({ where: { canonicalUrl: { contains: 'stone-3' }, job: { companyId: stone.id } } })).toBe(1);
  });

  it('"farklı firma": yeni firma açılır ve çift bir daha ikiz sayılmaz', async () => {
    const kartal = (await setupCompanyWithJob(h, u, { name: 'Kartal Ödeme Hizmetleri', withJob: false })).company;
    await apply([listing('Kartal Ödeme Lojistik', 'kartal-1')], 'test-decide-4');
    const decision = await h.prisma.companyDecision.findFirstOrThrow({ where: { workspaceId: workspaceId(), suggestedCompanyId: kartal.id } });
    await h.http().post(`/api/v1/home/company-decisions/${decision.id}`).set(u.auth).send({ action: 'separate' }).expect(201);
    await h.worker.drain();
    const created = await h.prisma.company.findFirstOrThrow({ where: { workspaceId: workspaceId(), name: 'Kartal Ödeme Lojistik' } });
    expect(await h.prisma.job.count({ where: { companyId: created.id } })).toBe(1);
    const twins = (await h.http().get('/api/v1/home/companies/twins').set(u.auth).expect(200)).body;
    expect(twins.some((t: { a: { id: string }; b: { id: string } }) => [t.a.id, t.b.id].includes(created.id) && [t.a.id, t.b.id].includes(kartal.id))).toBe(false);
    await h.http().post(`/api/v1/home/company-decisions/${decision.id}`).set(u.auth).send({ action: 'merge' }).expect(409);
  });

  it('ilanı olmayan benzer keşif hiç eklenmez', async () => {
    const before = await h.prisma.company.count({ where: { workspaceId: workspaceId() } });
    await h.app.get(ResearchService).applyDiscovery(workspaceId(), { companies: [{ name: 'Ornektas Stone Doğal Taş', reason: 'test', sourceUrl: 'https://x.example', signal: 'sector_fit' }] }, 'test-decide-5');
    expect(await h.prisma.company.count({ where: { workspaceId: workspaceId() } })).toBe(before);
  });

  it('kurum eklerken yazılan ada benzeyen kayıtlı firma söylenir', async () => {
    const similar = (await h.http().get('/api/v1/home/companies/similar').query({ name: 'Ornektas Stone Mermer' }).set(u.auth).expect(200)).body;
    expect(similar.match).toMatchObject({ id: stone.id, level: 'likely' });
    const none = (await h.http().get('/api/v1/home/companies/similar').query({ name: 'Bambaşka Yazılım' }).set(u.auth).expect(200)).body;
    expect(none.match).toBeNull();
  });
});
