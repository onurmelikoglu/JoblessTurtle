import { AiService } from '../../src/engine/ai/ai.service';
import { AutomationService } from '../../src/engine/automation.service';
import { JobSearchService } from '../../src/engine/job-search.service';
import { createHarness, Harness, resetDb, setupCompanyWithJob, setupUser, User } from './harness';

let h: Harness;
let u: User;
let applied: Awaited<ReturnType<typeof setupCompanyWithJob>>;
let twin: Awaited<ReturnType<typeof setupCompanyWithJob>>;
let other: Awaited<ReturnType<typeof setupCompanyWithJob>>;

const workspaceId = () => u.candidate.workspaceId as string;
const companies = async () => (await h.http().get('/api/v1/home/companies').set(u.auth).expect(200)).body as { companies: any[]; totals: any };
const notifications = (type: string) => h.prisma.notification.findMany({ where: { workspaceId: workspaceId(), type }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  u = await setupUser(h, 'basvurulan');
  jest.spyOn(h.app.get(AiService), 'run').mockResolvedValue({ status: 'unavailable', taskId: null, provider: null } as never);
  applied = await setupCompanyWithJob(h, u, { name: 'Kabuk Ajans (İstanbul)', domain: 'kabukajans.com' });
  const opportunityId = (await companies()).companies.find((c) => c.id === applied.company.id).opportunities[0].id;
  await h.http().post('/api/v1/home/mark-applied').set(u.auth).send({ opportunityId }).expect(201);
  await h.worker.drain();
  twin = await setupCompanyWithJob(h, u, { name: 'Kabuk Ajans (Türkiye / İstanbul)', domain: 'kabukajans.com.tr', title: 'Art Director' });
  other = await setupCompanyWithJob(h, u, { name: 'Kabuk Lojistik', domain: 'kabuklojistik.com' });
});

afterAll(async () => {
  jest.restoreAllMocks();
  await h.close();
});

describe('Başvurularım\'daki firma Firmalar\'a yansımaz', () => {
  it('başvurulan firma ve başka adla açılmış kaydı listelenmez; benzer adlı başka firma listelenir', async () => {
    const r = await companies();
    const ids = r.companies.map((c) => c.id);
    expect(ids).not.toContain(applied.company.id);
    expect(ids).not.toContain(twin.company.id);
    expect(ids).toContain(other.company.id);
    expect(r.totals.applied).toBe(2);
    const feed = (await h.http().get('/api/v1/home/opportunities').set(u.auth).expect(200)).body.items;
    expect(feed.map((o: any) => o.companyId)).not.toContain(twin.company.id);
  });

  it('başvurulan firmanın yeni ilanı yalnızca bilgilendirme bildirimi olur ve başvuruya götürür', async () => {
    const info = await notifications('applied_company_job');
    expect(info).toHaveLength(1);
    expect(info[0].title).toBe('Başvurduğun firmada yeni ilan: Art Director — Kabuk Ajans (Türkiye / İstanbul)');
    expect(info[0].body).toContain('bu firmaya (Kabuk Ajans (İstanbul)) başvurmuştun');
    const attempt = await h.prisma.applicationAttempt.findFirstOrThrow({ where: { companyId: applied.company.id } });
    expect(info[0].link).toBe(`/applications?attempt=${attempt.id}`);
    const fresh = await notifications('new_opportunity');
    expect(fresh.map((n) => n.title).join(' | ')).not.toContain('Kabuk Ajans (Türkiye');
  });

  it('başvurulan firmanın fırsatına otomatik taslak hazırlanmaz', async () => {
    const policy = { workspaceId: workspaceId(), searchProfileId: u.profile.id } as never;
    const candidates = await h.app.get(AutomationService).predraftCandidates(policy, 50);
    const opps = await h.prisma.opportunity.findMany({ where: { id: { in: candidates } }, select: { companyId: true } });
    expect(opps.map((o) => o.companyId)).not.toContain(twin.company.id);
    expect(opps.map((o) => o.companyId)).toContain(other.company.id);
    const twinOpp = await h.prisma.opportunity.findFirstOrThrow({ where: { companyId: twin.company.id } });
    expect(await h.app.get(AutomationService).onOpportunity(twinOpp.id)).toEqual([]);
    expect(await h.prisma.applicationDraft.count({ where: { companyId: twin.company.id } })).toBe(0);
  });

  it('ilan aramasının toplu "yeni ilan" bildirimi başvurulan firmanın ilanını saymaz', async () => {
    const profile = await h.prisma.searchProfile.findUniqueOrThrow({ where: { id: u.profile.id } });
    const before = (await notifications('new_jobs')).length;
    await h.app.get(JobSearchService).applyListings(profile, [{ title: 'Kreatif Direktör', company: 'Kabuk Ajans (İstanbul)', companyDomain: 'kabukajans.com', url: 'https://ilan.example/kabuk-1', location: 'Kadıköy, İstanbul' }], 'test-applied-1', { announced: true });
    await h.worker.drain();
    expect((await notifications('new_jobs')).length).toBe(before);
    await h.app.get(JobSearchService).applyListings(profile, [{ title: 'Kreatif Direktör', company: 'Yeni Kreatif', companyDomain: 'yenikreatif.example', url: 'https://ilan.example/yeni-1', location: 'Kadıköy, İstanbul' }], 'test-applied-2', { announced: true });
    await h.worker.drain();
    const after = await notifications('new_jobs');
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1].title).toBe('İş alarmından 1 yeni ilan eklendi');
  });
});

describe('bildirimler 30 gün tutulur', () => {
  it('30 günden eski bildirim listelenmez ve günlük temizlikte silinir', async () => {
    const me = (await h.http().get('/api/v1/me').set(u.auth).expect(200)).body;
    const userId = me.user?.id ?? me.id;
    await h.prisma.notification.createMany({
      data: [
        { workspaceId: workspaceId(), userId, eventId: 'eski-40', type: 'test', title: 'eski-40', channel: 'in_app', createdAt: new Date(Date.now() - 40 * 86_400_000) },
        { workspaceId: workspaceId(), userId, eventId: 'yeni-29', type: 'test', title: 'yeni-29', channel: 'in_app', createdAt: new Date(Date.now() - 29 * 86_400_000) },
      ],
    });
    const listed = (await h.http().get('/api/v1/notifications').set(u.auth).expect(200)).body.items.map((n: any) => n.title);
    expect(listed).toContain('yeni-29');
    expect(listed).not.toContain('eski-40');
    expect(await h.worker.cleanupNotifications()).toBe(1);
    expect(await h.prisma.notification.count({ where: { eventId: 'eski-40' } })).toBe(0);
    expect(await h.prisma.notification.count({ where: { eventId: 'yeni-29' } })).toBe(1);
  });
});
