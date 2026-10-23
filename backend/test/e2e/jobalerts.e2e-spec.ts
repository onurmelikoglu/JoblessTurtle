import { AiService } from '../../src/engine/ai/ai.service';
import { InboxService, buildIndex } from '../../src/engine/inbox.service';
import { JobAlertsService } from '../../src/engine/job-alerts.service';
import { FetchedMail } from '../../src/engine/mail/inbox';
import { createHarness, Harness, resetDb, setupUser, User } from './harness';

let h: Harness;
let u: User;
let alerts: JobAlertsService;
let inbox: InboxService;

const workspaceId = () => u.candidate.workspaceId as string;
const account = () => h.prisma.mailAccount.findUniqueOrThrow({ where: { id: u.account.id } });

const ALERT_HTML = `<html><body>
<table>
<tr><td><a href="https://link.kariyer.net/ls/click?upn=remax"><b>Kreatif Direktör</b></a><br>Remax Yaman<br>İstanbul(Asya) - Kadıköy</td></tr>
<tr><td><a href="https://www.kariyer.net/is-ilani/ornek-ajans-art-director-4500001?utm_source=alarm&utm_medium=email">Art Director</a><br>Örnek Ajans<br>İstanbul(Asya) - Üsküdar</td></tr>
<tr><td><a href="https://link.kariyer.net/ls/click?upn=muhasebe">Muhasebe Uzmanı</a><br>Defter Ltd.<br>İstanbul(Asya) - Kadıköy</td></tr>
<tr><td><a href="https://link.kariyer.net/ls/click?upn=tum">Tüm ilanları gör</a> · <a href="https://link.kariyer.net/ls/click?upn=cik">Abonelikten çık</a></td></tr>
</table></body></html>`;

function mail(patch: Partial<FetchedMail> = {}): FetchedMail {
  return { messageId: '<alarm-1@kariyer.net>', date: new Date(), fromEmail: 'isalarmi@kariyer.net', fromName: 'Kariyer.net', subject: 'İş Alarmı: Kreatif Direktör için 3 yeni ilan', text: '', headers: {}, contentType: 'text/html', raw: '', dsn: '', html: ALERT_HTML, ...patch };
}

/** Yalnızca ilan bildirimi görevi yanıtlanır; yeni firmanın araştırması gibi diğer görevler "kullanılamıyor" döner. */
function aiReads(listings: unknown[] | null) {
  return jest.spyOn(h.app.get(AiService), 'run').mockImplementation(async (req) =>
    req.kind === 'job_alert' && listings ? { status: 'succeeded', output: { listings }, provider: 'cli_claude', taskId: `alarm-${Date.now()}`, cached: false } : { status: 'unavailable', taskId: null, provider: null },
  );
}

const READ = [
  { title: 'Kreatif Direktör', company: 'Remax Yaman', location: 'İstanbul(Asya) - Kadıköy', workMode: 'unknown', link: 'L1' },
  { title: 'Art Director', company: 'Örnek Ajans', location: 'İstanbul(Asya) - Üsküdar', workMode: 'unknown', link: 'L2' },
  { title: 'Muhasebe Uzmanı', company: 'Defter Ltd.', location: 'İstanbul(Asya) - Kadıköy', workMode: 'unknown', link: 'L3' },
  { title: 'Uydurma İlan', company: 'Yok A.Ş.', location: null, workMode: 'unknown', link: 'L42' },
];

const jobsOf = (company: string) => h.prisma.job.findMany({ where: { workspaceId: workspaceId(), company: { name: company } }, include: { listings: { include: { source: true } } } });

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  alerts = h.app.get(JobAlertsService);
  inbox = h.app.get(InboxService);
  u = await setupUser(h, 'alarm');
  await h.worker.drain();
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('iş alarmı postası ilana dönüşür', () => {
  it('profile uyan ilanlar açık ilan olarak eklenir; firma yoksa oluşturulur, uymayan ve uydurma ilan atılır', async () => {
    const ai = aiReads(READ);
    jest.spyOn(alerts as any, 'listingUrl').mockImplementation(async (...args: unknown[]) => (String(args[0]).includes('upn=remax') ? 'https://www.kariyer.net/is-ilani/remax-yaman-kreatif-direktor-4512345' : String(args[0])));
    const result = await alerts.ingest(await account(), mail());
    expect(result).toMatchObject({ status: 'processed', fresh: 2, returned: 3 });
    const request = ai.mock.calls.map((c) => c[0]).find((r) => r.kind === 'job_alert')!;
    expect(request.input.platform).toBe('Kariyer.net');
    expect(request.input.text).toContain('Kreatif Direktör [L1]');
    expect(request.input.text).not.toMatch(/Abonelikten çık \[L/);
    expect(request.input.text).not.toContain('https://');

    const [remax] = await jobsOf('Remax Yaman');
    expect(remax).toMatchObject({ title: 'Kreatif Direktör', status: 'open', lastVerifiedAt: null });
    expect(remax.listings.map((l) => [l.source.kind, l.canonicalUrl, l.status])).toEqual([['job_alert', 'https://www.kariyer.net/is-ilani/remax-yaman-kreatif-direktor-4512345', 'open']]);
    const [other] = await jobsOf('Örnek Ajans');
    expect(other.listings[0].canonicalUrl).toBe('https://www.kariyer.net/is-ilani/ornek-ajans-art-director-4500001');
    expect(await jobsOf('Defter Ltd.')).toEqual([]);
    expect(await h.prisma.company.count({ where: { workspaceId: workspaceId(), name: { in: ['Defter Ltd.', 'Yok A.Ş.'] } } })).toBe(0);

    await h.worker.drain();
    const home = (await h.http().get('/api/v1/home/companies').set(u.auth).expect(200)).body;
    const listed = home.companies.find((c: any) => c.name === 'Remax Yaman');
    expect(listed).toMatchObject({ class: 'open', matchingJobs: 1 });
    expect(listed.opportunities[0].links[0]).toMatchObject({ kind: 'kariyernet', label: "Kariyer.net'te başvur" });
    const notes = (await h.http().get('/api/v1/notifications').set(u.auth).expect(200)).body.items;
    const note = notes.find((n: any) => n.type === 'new_jobs');
    expect(note.title).toBe('İş alarmından 2 yeni ilan eklendi');
    expect(note.link.split('=')[1].split(',').sort()).toEqual([remax.id, other.id].sort());
    const inboxView = (await h.http().get('/api/v1/home/inbox').set(u.auth).expect(200)).body;
    expect(inboxView.alerts).toMatchObject({ mails: 1, listings: 2, platforms: ['Kariyer.net'] });
    expect(inboxView.alerts.sites).toEqual([{ platform: 'Kariyer.net', mails: 1, lastAt: expect.any(String) }]);
    expect(inboxView.alerts.titles).toEqual(['Kreatif Direktör', 'Creative Director']);
    expect(inboxView.items).toEqual([]);
    expect(await h.prisma.learningEvent.findFirstOrThrow({ where: { kind: 'job_search', workspaceId: workspaceId() } })).toMatchObject({ features: { set: 'alert', platform: 'Kariyer.net' }, outcome: { fresh: 2, rejected: { title: 1 } } });
  });

  it('aynı ilan ertesi günkü postada yeniden gelirse yeni sayılmaz', async () => {
    aiReads(READ.slice(0, 2));
    jest.spyOn(alerts as any, 'listingUrl').mockImplementation(async (...args: unknown[]) => (String(args[0]).includes('upn=remax') ? 'https://www.kariyer.net/is-ilani/remax-yaman-kreatif-direktor-4512345' : String(args[0])));
    expect(await alerts.ingest(await account(), mail({ messageId: '<alarm-2@kariyer.net>' }))).toMatchObject({ status: 'processed', fresh: 0 });
    expect(await jobsOf('Remax Yaman')).toHaveLength(1);
  });

  it('hesap ve başvuru postaları ile iş sitesi dışından gelenler okunmaz', async () => {
    const ai = aiReads(READ);
    expect(await alerts.ingest(await account(), mail({ subject: 'Başvurunuz alındı: Kreatif Direktör' }))).toMatchObject({ status: 'not_alert' });
    expect(await alerts.ingest(await account(), mail({ subject: 'Şifre yenileme', html: '<a href="https://www.kariyer.net/sifre">Şifreni yenile</a>' }))).toMatchObject({ status: 'not_alert' });
    expect(await alerts.ingest(await account(), mail({ fromEmail: 'ik@baska.example' }))).toMatchObject({ status: 'not_job_site' });
    expect(ai).not.toHaveBeenCalled();
  });

  it('yapay zekâ kullanılamıyorsa bildirim bekletilir ve sonraki taramada işlenir', async () => {
    const html = '<a href="https://www.kariyer.net/is-ilani/bekleyen-ajans-kreatif-direktor-4600001">Kreatif Direktör</a><br>Bekleyen Ajans<br>İstanbul(Asya) - Kadıköy';
    aiReads(null);
    expect(await alerts.ingest(await account(), mail({ html, messageId: '<alarm-3@kariyer.net>' }))).toMatchObject({ status: 'waiting_ai', fresh: 0 });
    expect(await jobsOf('Bekleyen Ajans')).toEqual([]);
    jest.restoreAllMocks();
    aiReads([{ title: 'Kreatif Direktör', company: 'Bekleyen Ajans', location: 'İstanbul(Asya) - Kadıköy', workMode: 'unknown', link: 'L1' }]);
    expect(await alerts.retryPending(await account())).toEqual({ retried: 1 });
    expect(await jobsOf('Bekleyen Ajans')).toHaveLength(1);
    expect(await alerts.retryPending(await account())).toEqual({ retried: 0 });
  });

  it('gelen kutusu taraması iş sitesi postasını ilan bildirimi olarak işler ve saklamaz', async () => {
    const ingest = jest.spyOn(alerts, 'ingest').mockResolvedValue({ status: 'processed', fresh: 3, returned: 3 } as never);
    const stats = { matched: 0, created: 0, problems: 0, alerts: 0, jobs: 0 };
    const index = buildIndex({ accountEmail: u.account.accountEmail }, []);
    await inbox.handleMail(await account(), index, mail(), null, stats);
    await inbox.handleMail(await account(), index, mail({ fromEmail: 'biri@baska.example', subject: 'Merhaba' }), null, stats);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(stats).toEqual({ matched: 0, created: 0, problems: 0, alerts: 1, jobs: 3 });
    expect(await h.prisma.inboundMessage.count()).toBe(0);
  });
});
