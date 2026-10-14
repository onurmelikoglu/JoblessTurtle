import { recentOpenJobsFor } from '../../src/domain/catalog';
import { isInTurkey, workScopeOf } from '../../src/domain/geo';
import { buildJobQueries, companyNameKey, JobQueryLog, JobSearchProfile, listingExternalId, listingRejection, normalizeListingUrl, noteJobQuery, pickJobQueries, remoteOpenToTurkey, searchLocationOf } from '../../src/domain/job-search';
import { reportedStatus } from '../../src/domain/listing-status';
import { classifyTitle, normalizeTitle } from '../../src/domain/titles';
import { parseArbeitnow, parseHimalayas, parseRemoteOk, parseRemotive } from '../../src/engine/connectors/boards';
import { validateAiOutput } from '../../src/engine/ai/validate';

const profile: JobSearchProfile = {
  exactTitles: ['Flutter Developer', 'Mobile Developer', 'iOS Developer'],
  adjacentTitles: ['Mobil Uygulama Geliştirici', 'Android Developer', 'React Native Developer', 'Mobile Engineer', 'Swift Developer', 'Kotlin Developer'],
  excludedTitles: ['Intern'],
  city: 'İstanbul',
  districtsPrimary: ['Kadıköy'],
  allowRemote: false,
  abroadRemote: false,
  abroadRelocation: false,
  abroadRegions: [],
};
const HOUR = 3_600_000;

describe('unvan eşlemesi: Türkçe ve İngilizce yazımlar', () => {
  it('yaygın rol sözcükleri ortak forma iner, dolgu sözcükleri atılır', () => {
    expect(normalizeTitle('Kıdemli Mobil Uygulama Geliştirici')).toBe('senior mobile developer');
    expect(normalizeTitle('Mobile Application Developer')).toBe('mobile developer');
    expect(normalizeTitle('Yazılım Mühendisi')).toBe('software engineer');
    expect(normalizeTitle('Sosyal Medya Uzmanı')).toBe('social media specialist');
    expect(normalizeTitle('Sr. iOS Developer')).toBe('senior ios developer');
  });

  it('Türkçe ilan İngilizce unvanla, İngilizce ilan Türkçe unvanla eşleşir', () => {
    expect(classifyTitle('Mobil Uygulama Geliştirici (Flutter)', profile).match).toBe('exact');
    expect(classifyTitle('Senior Mobile App Developer', profile).match).toBe('exact');
    expect(classifyTitle('Sosyal Medya Uzmanı', { exactTitles: ['Social Media Specialist'], adjacentTitles: [], excludedTitles: [] }).match).toBe('exact');
    expect(classifyTitle('Stajyer Mobil Geliştirici', profile).match).toBe('excluded');
    expect(classifyTitle('Jr. Mobile Developer', profile).match).toBe('adjacent');
  });
});

describe('ilan kapsamı', () => {
  it('uzaktan, Türkiye, yurt dışı ve bilinmeyen ayrılır', () => {
    expect(workScopeOf('İstanbul (Hibrit)')).toBe('local');
    expect(workScopeOf('Çankaya, Ankara')).toBe('local');
    expect(workScopeOf('Gebze / Kocaeli, Türkiye')).toBe('local');
    expect(workScopeOf('Remote — Europe')).toBe('remote');
    expect(workScopeOf('Berlin, Germany')).toBe('abroad');
    expect(workScopeOf('München (Almanya/Avrupa)')).toBe('abroad');
    expect(workScopeOf('Abu Dhabi')).toBe('abroad');
    expect(workScopeOf('Merkez Ofis')).toBe('unknown');
    expect(workScopeOf(null)).toBe('unknown');
    expect(workScopeOf('Maslak', 'remote')).toBe('remote');
  });

  it('81 ilin hepsi Türkiye sayılır; yurt dışı şehri sayılmaz', () => {
    for (const city of ['Konya', 'Şanlıurfa', 'Muğla', 'Tekirdağ', 'Kahramanmaraş', 'Levent']) expect(isInTurkey(city)).toBe(true);
    for (const city of ['Berlin', 'London', 'Remote']) expect(isInTurkey(city)).toBe(false);
  });

  it('uzaktan ilan: kısıt yoksa ya da Türkiye\'yi kapsıyorsa açık, başka bölgeye bağlıysa kapalı', () => {
    for (const open of ['', null, 'Worldwide', 'Anywhere in the world', 'EMEA', 'Europe, Asia', 'EU', 'Türkiye', 'CET +/- 3h']) expect(remoteOpenToTurkey(open)).toBe(true);
    for (const locked of ['USA Only', 'Canada', 'LATAM', 'United Kingdom', 'India']) expect(remoteOpenToTurkey(locked)).toBe(false);
  });
});

describe('toplayıcıdan gelen ilanın profile uygunluğu', () => {
  const rejection = (listing: { title: string; locationText?: string | null; workMode?: string }, patch: Partial<JobSearchProfile> = {}) => listingRejection({ ...profile, ...patch }, listing);

  it('unvan eşleşmeyen ilan alınmaz', () => {
    expect(rejection({ title: 'Backend Developer', locationText: 'İstanbul' })).toBe('title');
    expect(rejection({ title: 'Flutter Developer Intern', locationText: 'İstanbul' })).toBe('title');
    expect(rejection({ title: 'Senior Flutter Developer', locationText: 'İstanbul' })).toBeNull();
    expect(rejection({ title: 'Flutter Developer', locationText: null })).toBeNull();
  });

  it('uzaktan ilan yalnızca istenirse; yurt dışı uzaktan ilan Türkiye\'ye açıksa alınır', () => {
    const tr = { title: 'Flutter Developer', locationText: 'İstanbul (Remote)' };
    expect(rejection(tr)).toBe('remote_not_wanted');
    expect(rejection(tr, { allowRemote: true })).toBeNull();
    const world = { title: 'Flutter Developer', locationText: 'Remote — Worldwide' };
    expect(rejection(world, { allowRemote: true })).toBe('remote_not_wanted');
    expect(rejection(world, { abroadRemote: true })).toBeNull();
    expect(rejection({ title: 'Flutter Developer', locationText: 'Remote — USA Only' }, { abroadRemote: true })).toBe('region_locked');
    expect(rejection({ title: 'Flutter Developer', locationText: 'Remote', workMode: 'remote' }, { abroadRemote: true })).toBeNull();
  });

  it('taşınma gerektiren ilan yalnızca istenirse ve tercih edilen bölgedeyse alınır', () => {
    const berlin = { title: 'iOS Developer', locationText: 'Berlin (Almanya/Avrupa)' };
    expect(rejection(berlin)).toBe('abroad_not_wanted');
    expect(rejection(berlin, { abroadRelocation: true })).toBeNull();
    expect(rejection(berlin, { abroadRelocation: true, abroadRegions: ['Almanya'] })).toBeNull();
    expect(rejection(berlin, { abroadRelocation: true, abroadRegions: ['Hollanda'] })).toBe('region_not_wanted');
  });
});

describe('sorgu planlayıcı', () => {
  it('aranan unvanlar ikişerli, yakın unvanlar beşerli gruplanır; her grup her kaynak kümesinde aranır', () => {
    const queries = buildJobQueries(profile);
    expect(queries).toHaveLength(4 * 3);
    expect(queries.filter((q) => q.priority === 0).map((q) => q.titles)).toEqual([...Array(3).fill(['Flutter Developer', 'Mobile Developer']), ...Array(3).fill(['iOS Developer'])]);
    expect(new Set(queries.map((q) => q.set))).toEqual(new Set(['tr_major', 'tr_boards', 'tr_company']));
    expect(new Set(queries.map((q) => q.key)).size).toBe(queries.length);
    expect(queries[0].location).toBe('İstanbul');
  });

  it('yurt dışı kapsamı açıldıkça uzaktan ve taşınma sorguları eklenir', () => {
    const abroad = buildJobQueries({ ...profile, abroadRemote: true, abroadRelocation: true, abroadRegions: ['Almanya', 'Hollanda'] });
    expect(abroad).toHaveLength(4 * 5);
    expect(abroad.find((q) => q.set === 'relocation')?.location).toBe('Almanya, Hollanda');
    expect(abroad.find((q) => q.set === 'remote_world')?.scope).toBe('remote');
  });

  it('anahtar unvan sırasından ve yazımından etkilenmez; unvan ya da bölge değişince değişir', () => {
    const key = (p: JobSearchProfile) => buildJobQueries(p)[0].key;
    expect(key({ ...profile, exactTitles: ['mobile developer', 'FLUTTER DEVELOPER', 'iOS Developer'] })).toBe(key(profile));
    expect(key({ ...profile, exactTitles: ['Backend Developer'] })).not.toBe(key(profile));
    expect(key({ ...profile, city: 'Ankara' })).not.toBe(key(profile));
  });

  it('bölge: tek şehir, seçilen şehirler ya da ülke geneli', () => {
    expect(searchLocationOf({ city: null, districtsPrimary: ['Kadıköy', 'Üsküdar', 'Ankara'] })).toBe('İstanbul, Ankara');
    expect(searchLocationOf({ city: null, districtsPrimary: [] })).toBe('Türkiye');
  });

  it('önce hiç çalışmamış sorgular (aranan unvanlar önde); yeni ilan getirmeyen sorgu iki kat uzun dinlenir', () => {
    const queries = buildJobQueries(profile);
    const now = Date.parse('2026-10-14T03:00:00Z');
    const first = pickJobQueries(queries, {}, { count: 4, now });
    expect(first.every((q) => q.priority === 0)).toBe(true);
    let log: JobQueryLog = {};
    for (const q of first) log = noteJobQuery(log, q.key, { returned: 10, fresh: q === first[0] ? 0 : 4 }, new Date(now));
    expect(pickJobQueries(queries, log, { count: 20, now: now + HOUR }).map((q) => q.key)).not.toEqual(expect.arrayContaining(first.map((q) => q.key)));
    const nextDay = pickJobQueries(queries, log, { count: 20, now: now + 25 * HOUR }).map((q) => q.key);
    expect(nextDay).toEqual(expect.arrayContaining(first.slice(1).map((q) => q.key)));
    expect(nextDay).not.toContain(first[0].key);
    expect(pickJobQueries(queries, log, { count: 20, now: now + 49 * HOUR }).map((q) => q.key)).toContain(first[0].key);
  });

  it('kullanıcı başlattığında dinlenme beklenmez; yalnızca son iki saatte çalışan sorgu atlanır', () => {
    const queries = buildJobQueries(profile);
    const now = Date.parse('2026-10-14T12:00:00Z');
    const log = noteJobQuery({}, queries[0].key, { returned: 5, fresh: 0 }, new Date(now - HOUR));
    const older = noteJobQuery(log, queries[1].key, { returned: 5, fresh: 0 }, new Date(now - 3 * HOUR));
    const picked = pickJobQueries(queries, older, { count: 20, now, force: true }).map((q) => q.key);
    expect(picked).not.toContain(queries[0].key);
    expect(picked).toContain(queries[1].key);
  });

  it('verim kaydı: yeni ilan gelince kuraklık sıfırlanır', () => {
    let log = noteJobQuery({}, 'k', { returned: 8, fresh: 0 });
    log = noteJobQuery(log, 'k', { returned: 6, fresh: 0 });
    expect(log.k).toMatchObject({ runs: 2, returned: 14, fresh: 0, dry: 2 });
    expect(noteJobQuery(log, 'k', { returned: 3, fresh: 2 }).k).toMatchObject({ runs: 3, fresh: 2, dry: 0 });
  });
});

describe('ilan bağlantısının tekilleştirilmesi', () => {
  it('LinkedIn ve Indeed ilanında ilan numarası esas alınır', () => {
    const linkedin = 'https://www.linkedin.com/jobs/view/4012345678';
    expect(normalizeListingUrl('https://tr.linkedin.com/jobs/view/senior-flutter-developer-at-ornek-4012345678?refId=abc&trackingId=xyz&position=3')).toBe(linkedin);
    expect(normalizeListingUrl('https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=flutter')).toBe(linkedin);
    expect(normalizeListingUrl('https://www.linkedin.com/jobs/view/4012345678/')).toBe(linkedin);
    expect(normalizeListingUrl('https://tr.indeed.com/viewjob?jk=abc123&from=serp&vjs=3')).toBe('https://tr.indeed.com/viewjob?jk=abc123');
  });

  it('izleme parametreleri ve çapa atılır; ilanı belirleyen parametre kalır', () => {
    expect(normalizeListingUrl('https://Ornek.com/kariyer/ilan/42/?utm_source=x&gh_src=y#basvur')).toBe('https://ornek.com/kariyer/ilan/42');
    expect(normalizeListingUrl('https://boards.greenhouse.io/ornek/jobs/123?gh_jid=123&utm_campaign=z')).toBe('https://boards.greenhouse.io/ornek/jobs/123?gh_jid=123');
    for (const bad of ['', null, 'ilan', 'javascript:alert(1)', 'ftp://ornek.com/x', 'https://localhost/x']) expect(normalizeListingUrl(bad)).toBeNull();
  });

  it('aynı ilanın farklı yazımları aynı kimliğe iner', () => {
    const id = (url: string) => listingExternalId(normalizeListingUrl(url)!);
    expect(id('http://www.ornek.com/kariyer/ilan/42?utm_source=a')).toBe(id('https://ornek.com/kariyer/ilan/42/'));
    expect(id('https://ornek.com/kariyer/ilan/42')).not.toBe(id('https://ornek.com/kariyer/ilan/43'));
  });

  it('firma adının çekirdeği: sondaki genel sözcükler atılır, anlamlı ad kalmalıdır', () => {
    expect(companyNameKey('Trendyol Group')).toBe(companyNameKey('Trendyol'));
    expect(companyNameKey('Getir Teknoloji A.Ş.')).toBe('getir');
    expect(companyNameKey('Insider Türkiye')).toBe('insider');
    expect(companyNameKey('Dream Games')).toBe('dream games');
    expect(companyNameKey('Group')).toBe('group');
  });
});

describe('doğrulanamayan ilan bildirimi', () => {
  it('yeni kayıt teyit bekler; doğrulanmış açık ilan açık kalır; kapanmış ilan yeniden açılmaz', () => {
    expect(reportedStatus('open')).toBe('unknown');
    expect(reportedStatus('open', 'unknown')).toBe('unknown');
    expect(reportedStatus('open', 'open')).toBe('open');
    expect(reportedStatus('open', 'closed')).toBe('closed');
    expect(reportedStatus('closed', 'open')).toBe('closed');
  });

  it('katalogdan yalnızca yakın zamanda açık görülmüş, bağlantılı ve eşleşen ilanlar taşınır', () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    const job = (title: string, patch: Record<string, unknown> = {}) => ({ title, status: 'open' as const, firstSeenAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-10-10T00:00:00.000Z', closedAt: null, url: 'https://ornek.com/ilan/1', location: null, ...patch });
    const jobs = [job('Flutter Developer'), job('iOS Developer', { lastSeenAt: '2026-09-01T00:00:00.000Z' }), job('Mobile Developer', { url: null }), job('Flutter Developer II', { status: 'closed' }), job('Muhasebe Uzmanı')];
    expect(recentOpenJobsFor(profile, jobs, now).map((j) => j.title)).toEqual(['Flutter Developer']);
  });
});

describe('ilan panoları', () => {
  it('Remotive: uzaktan ilan, bölge kısıtı konum metnine eklenir', () => {
    const [first, second] = parseRemotive({ jobs: [{ id: 1680495, url: 'https://remotive.com/remote-jobs/x-1680495', title: ' Flutter Developer ', company_name: 'Acme ', candidate_required_location: 'Worldwide', publication_date: '2026-10-11T20:17:27', description: '<p>Build <b>apps</b></p>' }, { id: 2, title: 'iOS Developer', company_name: 'B', candidate_required_location: '' }] });
    expect(first).toMatchObject({ externalId: '1680495', title: 'Flutter Developer', companyName: 'Acme', locationText: 'Remote — Worldwide', workMode: 'remote', url: 'https://remotive.com/remote-jobs/x-1680495', description: 'Build apps' });
    expect(first.postedAt?.toISOString().slice(0, 10)).toBe('2026-10-11');
    expect(second.locationText).toBe('Remote');
  });

  it('Remote OK: ilk satırdaki kullanım koşulu kaydı atlanır', () => {
    const listings = parseRemoteOk([{ last_updated: 1, legal: 'terms' }, { id: '1137062', position: 'Flutter Engineer', company: 'Kruger', location: '', url: 'https://remoteOK.com/remote-jobs/1137062', apply_url: 'https://remoteOK.com/remote-jobs/1137062', date: '2026-08-22T00:00:12+00:00' }]);
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({ externalId: '1137062', title: 'Flutter Engineer', companyName: 'Kruger', locationText: 'Remote', workMode: 'remote' });
  });

  it('Himalayas: bölge kısıtları ve son başvuru tarihi alınır', () => {
    const [listing] = parseHimalayas({ jobs: [{ title: 'Senior Flutter Developer', companyName: 'Rubicon', locationRestrictions: ['Canada', 'USA'], pubDate: 1791914301, expiryDate: 1797098300, applicationLink: 'https://himalayas.app/companies/rubicon/jobs/1', guid: 'https://himalayas.app/companies/rubicon/jobs/1' }] });
    expect(listing).toMatchObject({ title: 'Senior Flutter Developer', companyName: 'Rubicon', locationText: 'Remote — Canada, USA', url: 'https://himalayas.app/companies/rubicon/jobs/1' });
    expect(listing.externalId).toHaveLength(24);
    expect(listing.validThrough!.getTime()).toBeGreaterThan(listing.postedAt!.getTime());
  });

  it('Arbeitnow: konum Almanya/Avrupa olarak işaretlenir ki ilan yurt dışı sayılsın', () => {
    const [onsite, remote] = parseArbeitnow({ data: [{ slug: 'ios-dev-munchen-1', title: 'iOS Developer (m/w/d)', company_name: 'Slash', remote: false, location: 'München', url: 'https://www.arbeitnow.com/jobs/1', created_at: 1791911398 }, { slug: 'r-2', title: 'Flutter Dev', company_name: 'X', remote: true, location: '' }] });
    expect(onsite).toMatchObject({ externalId: 'ios-dev-munchen-1', locationText: 'München (Almanya/Avrupa)', workMode: 'unknown' });
    expect(workScopeOf(onsite.locationText)).toBe('abroad');
    expect(remote).toMatchObject({ locationText: 'Remote — Europe', workMode: 'remote' });
  });
});

describe('ilan araması çıktısı', () => {
  it('bağlantısı geçersiz ilan düşer, bozuk çalışma biçimi bilinmiyor sayılır, diğerleri kalır', () => {
    const v = validateAiOutput('job_search', {
      listings: [
        { title: 'Flutter Developer', company: 'Acme', url: 'https://acme.com/jobs/1', workMode: 'uzaktan' },
        { title: 'iOS Developer', company: 'Beta', url: 'linkedin' },
        { title: 'Mobile Developer', company: 'Gamma', url: 'https://gamma.io/careers/2', workMode: 'remote', postedAt: null },
        { company: 'Başlıksız', url: 'https://x.com/1' },
      ],
    });
    expect(v.ok).toBe(true);
    expect(v.output.listings.map((l: any) => [l.company, l.workMode])).toEqual([['Acme', 'unknown'], ['Gamma', 'remote']]);
  });
});
