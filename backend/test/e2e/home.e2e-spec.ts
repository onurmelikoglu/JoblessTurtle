import { ActivityService } from '../../src/engine/activity.service';
import { EvaluationService } from '../../src/engine/evaluation.service';
import { WorkerService } from '../../src/worker/worker.service';
import { createHarness, Harness, resetDb, setupCompanyWithJob, setupUser, User } from './harness';

let h: Harness;
let u: User;

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  u = await setupUser(h, 'home');
});

afterAll(async () => {
  await h.close();
});

async function companies() {
  return (await h.http().get('/api/v1/home/companies').set(u.auth).expect(200)).body as { companies: any[]; totals: any };
}

async function activity() {
  return (await h.http().get('/api/v1/home').set(u.auth).expect(200)).body.activity;
}

describe('başvurmadığım firmalar: üç sınıf', () => {
  let open: Awaited<ReturnType<typeof setupCompanyWithJob>>;
  let past: Awaited<ReturnType<typeof setupCompanyWithJob>>;
  let potential: Awaited<ReturnType<typeof setupCompanyWithJob>>;
  let unrelated: Awaited<ReturnType<typeof setupCompanyWithJob>>;

  beforeAll(async () => {
    open = await setupCompanyWithJob(h, u, { name: 'Açık Ajans' });
    past = await setupCompanyWithJob(h, u, { name: 'Geçmiş Ajans' });
    potential = await setupCompanyWithJob(h, u, { name: 'Potansiyel Ajans', withJob: false });
    unrelated = await setupCompanyWithJob(h, u, { name: 'İlgisiz İlanlı Ajans', title: 'Muhasebe Uzmanı' });
    await h.prisma.job.update({ where: { id: past.job.id }, data: { status: 'closed', closedAt: new Date() } });
    await h.prisma.job.update({ where: { id: open.job.id }, data: { applyUrl: 'https://www.linkedin.com/jobs/view/42', channel: 'email' } });
    const evaluation = h.app.get(EvaluationService);
    for (const c of [open, past, potential, unrelated]) await evaluation.evaluateCompany(c.company.id);
  });

  it('her firma tek sınıfa düşer ve sınıf sırasıyla listelenir', async () => {
    const r = await companies();
    expect(r.companies.map((c) => [c.name, c.class])).toEqual([
      ['Açık Ajans', 'open'],
      ['Geçmiş Ajans', 'past'],
      ['İlgisiz İlanlı Ajans', 'potential'],
      ['Potansiyel Ajans', 'potential'],
    ]);
    expect(r.totals).toMatchObject({ companies: 4, applied: 0, matchingJobs: 1, byClass: { open: 1, past: 1, potential: 2 } });
  });

  it('ilgisiz ilan ne ilan olarak ne sayı olarak döner', async () => {
    const r = await companies();
    const company = r.companies.find((c) => c.id === unrelated.company.id);
    expect(company.matchingJobs).toBe(0);
    expect(company.opportunities.map((o: any) => o.title)).toEqual([null]);
    expect(JSON.stringify(r)).not.toContain('Muhasebe Uzmanı');
    expect(company).not.toHaveProperty('otherOpenJobs');
    expect(company).not.toHaveProperty('openJobCount');
  });

  it('arama ve filtre alanları ile başvuru kanalları gelir', async () => {
    const r = await companies();
    const company = r.companies.find((c) => c.id === open.company.id);
    expect(company.sectors).toEqual(['kreatif ajans']);
    expect(company.matchingJobs).toBe(1);
    expect(company.links.map((l: any) => l.kind)).toContain('website');
    expect(company.opportunities[0].links).toEqual([{ kind: 'linkedin', label: "LinkedIn'de başvur", url: 'https://www.linkedin.com/jobs/view/42' }]);
    expect(typeof company.foundAt).toBe('string');
  });

  it('başvurulan firma listeden çıkar, toplamda sayılır', async () => {
    const before = await companies();
    const opportunityId = before.companies.find((c) => c.id === potential.company.id).opportunities[0].id;
    await h.http().post('/api/v1/home/mark-applied').set(u.auth).send({ opportunityId }).expect(201);
    const after = await companies();
    expect(after.companies.map((c) => c.id)).not.toContain(potential.company.id);
    expect(after.totals).toMatchObject({ companies: 3, applied: 1, byClass: { open: 1, past: 1, potential: 1 } });
    const applications = (await h.http().get('/api/v1/home/applications').set(u.auth).expect(200)).body.items;
    expect(applications.map((a: any) => a.companyId)).toEqual([potential.company.id]);
  });

  it('kullanıcının gizlediği tek fırsatı kalan firma listelenmez', async () => {
    const before = await companies();
    const opportunityId = before.companies.find((c) => c.id === unrelated.company.id).opportunities[0].id;
    await h.http().patch(`/api/v1/opportunities/${opportunityId}`).set(u.auth).send({ status: 'dismissed' }).expect(200);
    const after = await companies();
    expect(after.companies.map((c) => c.name)).toEqual(['Açık Ajans', 'Geçmiş Ajans']);
  });
});

describe('durum paneli gerçek işe bakar', () => {
  const aiTask = (minutesAgo: number, kind = 'company_report') =>
    h.prisma.aiTask.create({ data: { workspaceId: u.candidate.workspaceId, kind, provider: 'cli_claude', status: 'running', inputHash: `h-${minutesAgo}-${kind}`, prompt: 'p', input: {}, createdAt: new Date(Date.now() - minutesAgo * 60_000) } });

  beforeEach(async () => {
    await h.worker.drain();
    await h.prisma.aiTask.deleteMany({ where: { status: 'running' } });
  });

  it('çalışan iş yokken beklemededir; worker bildirimi yoksa çevrimdışı görünür', async () => {
    const a = await activity();
    expect(a.status).toBe('idle');
    expect(a.items).toEqual([]);
    expect(a.workerOnline).toBe(false);
    expect(a).not.toHaveProperty('searching');
  });

  it('çalışan AI görevi türüyle birlikte görünür', async () => {
    await aiTask(2);
    await aiTask(1, 'company_contacts');
    const a = await activity();
    expect(a.status).toBe('working');
    expect(a.items).toEqual([
      { kind: 'research', label: 'Firma analizi', running: 1, queued: 0 },
      { kind: 'contacts', label: 'Mail adresi araması', running: 1, queued: 0 },
    ]);
  });

  it('günlerdir "çalışıyor" kalmış görev sayılmaz ve temizlenir', async () => {
    const stuck = await aiTask(5 * 24 * 60, 'company_discovery');
    expect((await activity()).status).toBe('idle');
    expect(await h.app.get(ActivityService).reapStuckAiTasks()).toBe(1);
    expect((await h.prisma.aiTask.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe('failed');
  });

  it('worker anlık görüntüsü kuyruk derinliğini ekler; rutin tarama durumu değiştirmez', async () => {
    const ws = u.candidate.workspaceId;
    await h.app.get(ActivityService).saveSnapshot({ [ws]: { routine: { running: 2, queued: 7 } } });
    let a = await activity();
    expect(a.workerOnline).toBe(true);
    expect(a.status).toBe('idle');
    expect(a.routineCrawls).toBe(9);
    await h.app.get(ActivityService).saveSnapshot({ [ws]: { research: { running: 2, queued: 14 } }, baska: { letters: { running: 1, queued: 0 } } });
    a = await activity();
    expect(a.status).toBe('working');
    expect(a.items).toEqual([{ kind: 'research', label: 'Firma analizi', running: 2, queued: 14 }]);
  });

  it('durdurulmuş aramada durum "durduruldu" olur ve sıradaki tarama gösterilmez', async () => {
    await h.http().post('/api/v1/home/search/stop').set(u.auth).expect(201);
    const a = await activity();
    expect(a.status).toBe('paused');
    expect(a.nextScanAt).toBeNull();
    expect(a.nextDiscoveryAt).toBeNull();
  });
});

describe('worker etkinlik bildirimi (gerçek kuyruk)', () => {
  const LATER_MS = 10 * 60_000;

  it('kuyrukta bekleyen işleri çalışma alanı ve türe göre sayar; zamanı gelmemiş gönderimi saymaz', async () => {
    const worker = h.app.get(WorkerService) as any;
    const workspaceId = u.candidate.workspaceId;
    const company = await h.prisma.company.findFirstOrThrow({ where: { workspaceId } });
    const source = await h.prisma.sourceConnector.findFirstOrThrow({ where: { workspaceId } });
    // Önceki testten kalan "aramayı durdur" olayı gerçek kuyrukta işlenirse bu testin eklediği işleri de siler.
    await h.worker.drain();
    worker.inline = null;
    await worker.start({ scheduler: false, telegram: false });
    try {
      await worker.enqueue('research', 'company', { companyId: company.id }, `activity-research-${Date.now()}`, LATER_MS);
      await worker.enqueue('research', 'company_details', { companyId: company.id }, `activity-contacts-${Date.now()}`, LATER_MS);
      await worker.enqueue('collect', 'source', { sourceId: source.id, trigger: 'schedule' }, `activity-crawl-${Date.now()}`, LATER_MS);
      await worker.enqueue('send', 'attempt', { attemptId: 'yok' }, `activity-send-${Date.now()}`, LATER_MS);
      await worker.publishActivity();
      const a = await activity();
      expect(a.workerOnline).toBe(true);
      expect(a.items).toEqual([
        { kind: 'research', label: 'Firma analizi', running: 0, queued: 1 },
        { kind: 'contacts', label: 'Mail adresi araması', running: 0, queued: 1 },
      ]);
      expect(a.routineCrawls).toBe(1);
    } finally {
      for (const queue of worker.queues.values()) await queue.obliterate({ force: true });
      await worker.stop();
      worker.enableInline();
    }
  });
});
