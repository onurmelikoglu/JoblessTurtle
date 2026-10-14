/* eslint-disable no-console */
/**
 * Demo verisi: kurgusal firmalar (.example alan adları), demo ilan kaynağı, örnek aday ve arama profili.
 * Gerçek bir işverene istek atmaz ve e-posta göndermez (Fake mail sağlayıcısı).
 * Kullanım: npm run db:seed   (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD ile değiştirilebilir)
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const norm = (s: string) =>
  s
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Tek sayfalık geçerli PDF üretir (demo CV/portföy). */
function makePdf(lines: string[]): Buffer {
  const text = lines.map((l, i) => `BT /F1 12 Tf 60 ${760 - i * 18} Td (${l.replace(/[()\\]/g, '')}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const COMPANIES = [
  { name: 'Moda Kreatif Ajans', domain: 'modakreatif.example', district: 'Kadıköy', sectors: ['kreatif ajans', 'dijital ajans'], services: ['marka iletişimi', 'film prodüksiyonu', 'sosyal medya'] },
  { name: 'Altunizade Film', domain: 'altunizadefilm.example', district: 'Üsküdar', sectors: ['prodüksiyon'], services: ['reklam filmi', 'post prodüksiyon'] },
  { name: 'Ataşehir Dijital', domain: 'atasehirdijital.example', district: 'Ataşehir', sectors: ['dijital ajans'], services: ['performans pazarlama', 'içerik üretimi'] },
  { name: 'Levent Brand Studio', domain: 'leventbrand.example', district: 'Beşiktaş', sectors: ['kreatif ajans'], services: ['marka stratejisi', 'kampanya'] },
  { name: 'Ümraniye Yapım', domain: 'umraniyeyapim.example', district: 'Ümraniye', sectors: ['prodüksiyon'], services: ['dijital içerik', 'stüdyo çekimi'] },
  { name: 'Karaköy İçerik Evi', domain: 'karakoyicerik.example', district: 'Beyoğlu', sectors: ['içerik ajansı'], services: ['içerik stratejisi', 'video'] },
  { name: 'Bakırköy Satış Ortakları', domain: 'bakirkoysatis.example', district: 'Bakırköy', sectors: ['satış danışmanlığı'], services: ['saha satış'] },
  { name: 'Şişli Marka Ekibi', domain: 'sislimarka.example', district: 'Şişli', sectors: ['marka içi yaratıcı ekip'], services: ['kurum içi kreatif'] },
];

async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'demo@ornek.local').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'demo12345';
  const storageDir = path.resolve(process.env.STORAGE_DIR ?? './storage');

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Seed atlandı: ${email} zaten var.`);
    return;
  }
  const first = (await prisma.user.count()) === 0;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await argon2.hash(password),
      displayName: 'Demo Kullanıcı',
      isAdmin: first,
      notificationSettings: { mode: 'instant', quietStart: '23:00', quietEnd: '08:00', minScore: 0, telegramEnabled: true },
    },
  });
  const ws = await prisma.workspace.create({
    data: { name: 'Demo çalışma alanı', ownerId: user.id, aiSettings: { providerOrder: first ? ['cli_claude', 'manual', 'template'] : ['manual', 'template'], dailyTaskLimit: 60, webResearch: true } },
  });
  await prisma.membership.create({ data: { workspaceId: ws.id, userId: user.id, role: 'owner' } });

  const candidate = await prisma.candidateProfile.create({
    data: {
      workspaceId: ws.id,
      ownerId: user.id,
      displayName: 'Deniz Örnek',
      email: 'deniz.ornek@ornek.local',
      headline: 'Marka iletişimi ve film prodüksiyonunda ekip yöneten kreatif direktörüm.',
      city: 'İstanbul',
      experienceYears: 12,
      teamManagement: true,
      verifiedFacts: [
        { key: 'experience', label: 'Ajans deneyimi', value: '12 yıl ajans deneyimi' },
        { key: 'team', label: 'Ekip yönetimi', value: '8 kişilik kreatif ekip yönetimi' },
        { key: 'lang', label: 'Dil', value: 'İngilizce (ileri)' },
      ],
      languages: [{ language: 'Türkçe', level: 'Anadil' }, { language: 'İngilizce', level: 'İleri' }],
      workModes: ['onsite', 'hybrid'],
      employmentTypes: ['tam zamanlı'],
      portfolioUrl: 'https://portfolyo.ornek.local/deniz',
      portfolioItems: [
        { title: 'Yaz kampanyası film serisi', client: 'Örnek İçecek', year: 2025, tags: ['film', 'kampanya'] },
        { title: 'Marka yenileme lansmanı', client: 'Örnek Banka', year: 2024, tags: ['marka', 'lansman'] },
        { title: 'Sosyal medya içerik sistemi', client: 'Örnek Perakende', year: 2025, tags: ['dijital', 'içerik'] },
      ],
      signature: 'Deniz Örnek\nKreatif Direktör\n+90 555 000 00 00',
      consentVersion: 'v1',
    },
  });

  const profile = await prisma.searchProfile.create({
    data: {
      workspaceId: ws.id,
      candidateId: candidate.id,
      name: 'İstanbul Kreatif',
      exactTitles: ['Kreatif Direktör', 'Creative Director', 'Creative Lead'],
      adjacentTitles: ['Creative Producer', 'Head of Creative', 'Art Director'],
      excludedTitles: ['Sales Director', 'IT Director', 'Moda Ürün Tasarım Direktörü'],
      sectors: ['kreatif ajans', 'dijital ajans', 'prodüksiyon', 'içerik ajansı', 'marka içi yaratıcı ekip'],
      excludedSectors: ['satış danışmanlığı'],
      keywords: ['kampanya', 'film', 'marka', 'ekip', 'kreatif', 'creative', 'campaign', 'brand'],
      city: 'İstanbul',
      districtsPrimary: ['Kadıköy', 'Üsküdar', 'Ataşehir', 'Ümraniye'],
      districtsConditional: ['Şişli', 'Beşiktaş', 'Levent', 'Karaköy'],
      allowRemote: false,
      allowHybrid: true,
      unknownLocationAction: 'review',
      autoIncludeAdjacent: false,
      requiredConditions: [
        { key: 'team', label: 'Ekip yönetimi deneyimi', required: true, met: true },
        { key: 'english', label: 'İngilizce', required: false, met: true },
      ],
    },
  });

  // Demo belgeler
  const docs = [];
  for (const [type, label, lines] of [
    ['cv', 'CV TR v1', ['Deniz Ornek - Kreatif Direktor', '12 yil ajans deneyimi', '8 kisilik ekip yonetimi']],
    ['portfolio', 'Portföy 2025', ['Deniz Ornek - Portfolyo', 'Yaz kampanyasi film serisi', 'Marka yenileme lansmani']],
  ] as const) {
    const buf = makePdf([...lines]);
    const key = `candidates/${candidate.id}/${randomUUID()}`;
    await fs.mkdir(path.join(storageDir, path.dirname(key)), { recursive: true });
    await fs.writeFile(path.join(storageDir, key), buf);
    docs.push(
      await prisma.documentVersion.create({
        data: { workspaceId: ws.id, candidateId: candidate.id, type, language: 'tr', label, fileName: `${label.replace(/\s+/g, '_')}.pdf`, objectKey: key, sha256: sha(buf), mime: 'application/pdf', size: buf.length, scanState: 'clean', revision: 1 },
      }),
    );
  }

  const account = await prisma.mailAccount.create({
    data: { workspaceId: ws.id, candidateId: candidate.id, provider: 'fake', accountEmail: 'deniz.ornek@ornek.local', displayName: 'Deniz Örnek', scopeSet: ['send'], dailyLimit: 20 },
  });

  // Firmalar, ofisler, kanıtlar ve resmî iletişimler
  const byDomain: Record<string, string> = {};
  for (const [i, c] of COMPANIES.entries()) {
    const company = await prisma.company.create({
      data: {
        workspaceId: ws.id,
        name: c.name,
        normalizedName: norm(c.name),
        canonicalDomain: c.domain,
        website: `https://${c.domain}`,
        sectors: c.sectors,
        services: c.services,
        origin: 'manual',
        notes: 'Demo verisi (kurgusal firma)',
        watch: i < 2,
      },
    });
    byDomain[c.domain] = company.id;
    await prisma.office.create({ data: { companyId: company.id, kind: 'hq', district: c.district, city: 'İstanbul', label: 'Merkez', locationConfidence: 'high' } });
    await prisma.contactPoint.create({
      data: {
        workspaceId: ws.id,
        companyId: company.id,
        email: i === 2 ? `info@${c.domain}` : `kariyer@${c.domain}`,
        kind: i === 2 ? 'general' : 'official_hr',
        purpose: i === 2 ? 'Genel iletişim' : 'Kariyer/İK başvuru adresi',
        sourceUrl: `https://${c.domain}/kariyer`,
        confidence: 'high',
        ownershipEvidence: 'Resmî sitede yayımlanmış; alan adı eşleşiyor (demo)',
        verifiedAt: new Date(),
        verifiedBy: 'source',
      },
    });
    const strong = i < 3 || i === 4;
    const evidence = [
      { dimension: 'customer', customerName: 'Örnek İçecek', scope: 'local', claimType: 'dated_case', title: 'Örnek İçecek yaz kampanyası', confidence: strong ? 'high' : 'medium', evidenceDate: new Date('2026-05-01') },
      { dimension: 'customer', customerName: 'Global Marka', scope: 'global', claimType: 'logo_wall', title: 'Global ağ müşterisi (logo duvarı)', confidence: 'low', evidenceDate: null },
      { dimension: 'campaign', customerName: null, scope: 'local', claimType: 'dated_case', title: 'Tarihli film vakası', confidence: strong ? 'high' : 'medium', evidenceDate: new Date('2026-02-01') },
      ...(strong ? [{ dimension: 'service_fit', customerName: null, scope: 'unknown', claimType: 'service', title: 'Film ve kampanya hizmetleri', confidence: 'high', evidenceDate: null }] : []),
      ...(i === 0 ? [{ dimension: 'reputation', customerName: null, scope: 'local', claimType: 'award', title: 'Ulusal reklam ödülü (demo)', confidence: 'high', evidenceDate: new Date('2025-11-01') }] : []),
      ...(i < 2 ? [{ dimension: 'production', customerName: null, scope: 'local', claimType: 'team', title: 'İç stüdyo ve prodüksiyon ekibi', confidence: 'high', evidenceDate: null }] : []),
    ];
    for (const e of evidence) {
      await prisma.companyEvidence.create({ data: { ...e, workspaceId: ws.id, companyId: company.id, url: `https://${c.domain}/isler`, createdBy: 'user', summary: 'Demo kanıt' } });
    }
  }

  // Demo ilan kaynağı: yaşam döngüsünü gösterir (2. çalıştırmadan sonra bir ilan kapanır, 3.'de yenisi açılır).
  await prisma.sourceConnector.create({
    data: {
      workspaceId: ws.id,
      kind: 'demo',
      name: 'Demo ATS (çevrimdışı örnek)',
      accessMode: 'api',
      capabilities: ['discover', 'detail', 'verify'],
      intervalMinutes: 10,
      minIntervalMinutes: 1,
      isOfficial: true,
      health: 'unknown',
      permissionEvidence: 'Demo veri — gerçek kaynağa istek atılmaz',
      nextRunAt: new Date(),
      config: {
        run: 1,
        listings: [
          { externalId: 'D-100', title: 'Kreatif Direktör', companyName: 'Moda Kreatif Ajans', companyDomain: 'modakreatif.example', locationText: 'Kadıköy, İstanbul', description: 'Marka kampanyaları ve film prodüksiyonlarında kreatif ekibi yönetecek, müşteri sunumlarını üstlenecek kreatif direktör arıyoruz. Ekip yönetimi deneyimi zorunludur.', applyEmail: 'kariyer@modakreatif.example', requisitionId: 'MKA-2026-07' },
          { externalId: 'D-101', title: 'Head of Creative', companyName: 'Altunizade Film', companyDomain: 'altunizadefilm.example', locationText: 'Altunizade, Üsküdar', description: 'Reklam filmi projelerinde kreatif yönlendirme ve marka kampanyası geliştirme.', applyEmail: 'kariyer@altunizadefilm.example' },
          { externalId: 'D-102', title: 'Sales Director', companyName: 'Bakırköy Satış Ortakları', companyDomain: 'bakirkoysatis.example', locationText: 'Bakırköy, İstanbul', description: 'Saha satış ekibini yönetecek satış direktörü.' },
          { externalId: 'D-103', title: 'Creative Director', companyName: 'Levent Brand Studio', companyDomain: 'leventbrand.example', locationText: 'Levent, İstanbul', description: 'Brand campaigns, film and digital content; leading a creative team.', applyEmail: 'kariyer@leventbrand.example', closeAfterRun: 2 },
          { externalId: 'D-104', title: 'Senior Creative Director', companyName: 'Ümraniye Yapım', companyDomain: 'umraniyeyapim.example', locationText: 'Ümraniye, İstanbul', description: 'Dijital içerik ve stüdyo çekimlerinde kampanya ve marka film süreçlerini yönetecek, ekip yönetimi deneyimli kreatif lider.', applyEmail: 'kariyer@umraniyeyapim.example', openFromRun: 3 },
          { externalId: 'D-105', title: 'Associate Creative Director', companyName: 'Ataşehir Dijital', companyDomain: 'atasehirdijital.example', locationText: 'İstanbul', description: 'Performans ve içerik kampanyalarında kreatif destek.' },
        ],
      },
    },
  });

  await prisma.automationPolicy.create({
    data: {
      workspaceId: ws.id,
      candidateId: candidate.id,
      searchProfileId: profile.id,
      mailAccountId: account.id,
      name: 'Açık hedef ilanlara otomatik başvuru (Fake)',
      modeJobApplication: true,
      modeGeneralIntent: false,
      modeFollowUp: false,
      documentIds: docs.map((d) => d.id),
      sendImmediately: true,
    },
  });

  const invite = await prisma.invite.create({ data: { code: 'ARKADAS2026', issuedById: user.id, expiresAt: new Date(Date.now() + 30 * 86400_000) } });

  await prisma.outboxEvent.create({ data: { workspaceId: ws.id, eventType: 'evaluate.profile', aggregateId: profile.id, dedupKey: `seed-eval:${profile.id}` } });

  console.log('Demo verisi oluşturuldu:');
  console.log(`  Giriş: ${email} / ${password}${first ? ' (sunucu yöneticisi)' : ''}`);
  console.log(`  Arkadaş daveti kodu: ${invite.code}`);
  console.log(`  ${COMPANIES.length} kurgusal firma, 1 demo ilan kaynağı, 2 belge, Fake mail hesabı`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
