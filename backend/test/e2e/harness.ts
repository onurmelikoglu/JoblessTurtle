import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { execSync } from 'child_process';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma.service';
import { AllExceptionsFilter } from '../../src/common/http-exception.filter';
import { WorkerService } from '../../src/worker/worker.service';

export interface Harness {
  app: INestApplication;
  prisma: PrismaService;
  worker: WorkerService;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

let migrated = false;

export async function createHarness(): Promise<Harness> {
  if (!migrated) {
    execSync('npx prisma migrate deploy', { env: process.env, stdio: 'ignore', cwd: `${__dirname}/../..` });
    migrated = true;
  }
  const moduleRef = await Test.createTestingModule({ imports: [AppModule], providers: [WorkerService] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  // supertest kendi açtığı sunucuyu "::" üzerinde dinletip 127.0.0.1'e bağlanır; makinedeki başka bir süreç aynı portu
  // 127.0.0.1'de tutuyorsa istek o sürece gider (rastgele 403/404/socket hang up). Sunucu doğrudan 127.0.0.1'de açılır.
  await app.listen(0, '127.0.0.1');
  const prisma = app.get(PrismaService);
  const worker = app.get(WorkerService);
  worker.enableInline();
  return {
    app,
    prisma,
    worker,
    http: () => request(app.getHttpServer()),
    close: async () => {
      await app.close();
    },
  };
}

export async function resetDb(prisma: PrismaService) {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
}

let counter = 0;

/** Kayıt olup temel kurulum yapar: aday, arama profili, Fake hesap, temiz CV belgesi. */
export async function setupUser(h: Harness, name = `u${++counter}`) {
  const email = `${name}-${Date.now()}@test.local`;
  const reg = await h.http().post('/api/v1/auth/register').send({ email, password: 'sifre12345', displayName: name }).expect(201);
  const token = reg.body.accessToken as string;
  const auth = { Authorization: `Bearer ${token}` };
  const candidate = (
    await h
      .http()
      .post('/api/v1/candidates')
      .set(auth)
      .send({
        displayName: `${name} Aday`,
        email: `${name}@aday.local`,
        headline: 'Kreatif direktörüm.',
        experienceYears: 10,
        verifiedFacts: [{ key: 'exp', label: 'Deneyim', value: '10 yıl ajans deneyimi' }],
        portfolioUrl: 'https://portfolyo.local/x',
        portfolioItems: [{ title: 'Kampanya filmi', client: 'Marka', year: 2025 }],
        signature: `${name} Aday`,
      })
      .expect(201)
  ).body;
  const profile = (
    await h
      .http()
      .post('/api/v1/search-profiles')
      .set(auth)
      .send({
        candidateId: candidate.id,
        name: 'İstanbul Kreatif',
        exactTitles: ['Kreatif Direktör', 'Creative Director'],
        adjacentTitles: ['Head of Creative', 'Art Director'],
        excludedTitles: ['Sales Director'],
        sectors: ['kreatif ajans'],
        districtsPrimary: ['Kadıköy', 'Üsküdar'],
        districtsConditional: ['Beşiktaş'],
        requiredConditions: [{ key: 'team', label: 'Ekip yönetimi', required: true, met: true }],
      })
      .expect(201)
  ).body;
  const account = (await h.http().post('/api/v1/mail-accounts/fake').set(auth).send({ candidateId: candidate.id, accountEmail: `${name}@aday.local` }).expect(201)).body;
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
  const doc = (
    await h.http().post('/api/v1/documents').set(auth).field('candidateId', candidate.id).field('type', 'cv').field('language', 'tr').attach('file', pdf, 'cv.pdf').expect(201)
  ).body;
  return { email, token, auth, candidate, profile, account, doc };
}

export type User = Awaited<ReturnType<typeof setupUser>>;

/** Firma + resmî İK adresi + (isteğe bağlı) demo kaynaktan açık ilan. */
export async function setupCompanyWithJob(
  h: Harness,
  u: User,
  opts: { name?: string; domain?: string; title?: string; location?: string; withJob?: boolean; contactKind?: string } = {},
) {
  const domain = opts.domain ?? `firma${++counter}.example`;
  const company = (
    await h
      .http()
      .post('/api/v1/companies')
      .set(u.auth)
      .send({ name: opts.name ?? `Firma ${counter}`, website: domain, sectors: ['kreatif ajans'], district: 'Kadıköy' })
      .expect(201)
  ).body;
  const contact = (
    await h
      .http()
      .post(`/api/v1/companies/${company.id}/contacts`)
      .set(u.auth)
      .send({ email: `kariyer@${domain}`, verified: true, ...(opts.contactKind ? { kind: opts.contactKind } : {}) })
      .expect(201)
  ).body;
  let job: any = null;
  if (opts.withJob !== false) {
    job = (
      await h
        .http()
        .post('/api/v1/jobs/manual')
        .set(u.auth)
        .send({ platform: 'manual', companyId: company.id, title: opts.title ?? 'Kreatif Direktör', locationText: opts.location ?? 'Kadıköy, İstanbul', applyEmail: `kariyer@${domain}`, description: 'Kampanya ve film ekibini yönetecek kreatif direktör.' })
        .expect(201)
    ).body;
    // Manuel kayıt teyit gerektirir; test için resmî kaynak doğrulaması simüle edilir.
    await h.prisma.job.update({ where: { id: job.id }, data: { status: 'open', lastVerifiedAt: new Date(), channel: 'email' } });
  }
  await h.worker.drain();
  return { company, contact, job, domain };
}

export async function createDraft(h: Harness, u: User, companyId: string, jobId: string | null, extra: Record<string, unknown> = {}) {
  const res = await h
    .http()
    .post('/api/v1/drafts')
    .set(u.auth)
    .send({ candidateId: u.candidate.id, companyId, jobId, mailAccountId: u.account.id, documentIds: [u.doc.id], useAi: false, ...extra })
    .expect(201);
  return res.body;
}

export function idem() {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
