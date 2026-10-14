import { readFileSync } from 'fs';
import { join } from 'path';
import { ashbyConnector, parseAshby } from '../../src/engine/connectors/ashby';
import { ATS_CONNECTORS, atsBoardLink, detectAtsSource } from '../../src/engine/connectors/ats-detect';
import { BOARD_API_MAX_BYTES, fetchSource } from '../../src/engine/connectors/http';
import { parsePersonio, personioConnector } from '../../src/engine/connectors/personio';
import { parseRecruitee, recruiteeConnector } from '../../src/engine/connectors/recruitee';
import { parseSmartRecruiters, smartRecruitersConnector } from '../../src/engine/connectors/smartrecruiters';
import { parseTeamtailor, teamtailorConnector } from '../../src/engine/connectors/teamtailor';
import { parseWorkable, workableConnector } from '../../src/engine/connectors/workable';

jest.mock('../../src/engine/connectors/http');

const fetchMock = fetchSource as jest.MockedFunction<typeof fetchSource>;

const FIXTURES = join(__dirname, 'fixtures', 'ats');
const fixtureText = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const fixtureJson = (name: string) => JSON.parse(fixtureText(name));
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const source = (config: Record<string, unknown>, etag: string | null = null) => ({ config, etag }) as any;

function okResponse(body: unknown, options: { headers?: Record<string, string>; url?: string } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    state: 'ok' as const,
    status: 200,
    contentHash: `hash-of-${text.length}`,
    res: { status: 200, url: options.url ?? '', headers: options.headers ?? {}, body: Buffer.from(text), text: () => text, json: () => JSON.parse(text) },
  };
}

beforeEach(() => fetchMock.mockReset());

describe('Workable ilan ayrıştırma', () => {
  const listings = parseWorkable(fixtureJson('workable.json'));

  it('kısa kodu kimlik yapar; başlık, ilan ve başvuru bağlantılarını eşler', () => {
    expect(listings.map((l) => l.externalId)).toEqual(['186545F8C1', '407973D643', 'DB1A13AC0A']);
    expect(listings[0].title).toBe('Client Experience Coordinator (English & Greek Speaker) - Talent Pool');
    expect(listings[0].url).toBe('https://apply.workable.com/j/186545F8C1');
    expect(listings[0].applyUrl).toBe('https://apply.workable.com/j/186545F8C1/apply');
  });

  it('konumu şehir, bölge, ülke olarak birleştirir; uzaktan ilanı işaretler', () => {
    expect(listings[0].locationText).toBe('Athens, Attica, Greece');
    expect(listings[0].workMode).toBe('unknown');
    expect(listings[1].locationText).toBe('Brazil | Remote');
    expect(listings[1].workMode).toBe('remote');
  });

  it('yayın tarihini, pozisyon kodunu ve sade metin açıklamayı verir', () => {
    expect(iso(listings[0].postedAt)).toBe('2026-02-12T00:00:00.000Z');
    expect(listings[0].requisitionId).toBeNull();
    expect(listings[2].requisitionId).toBe('BA 0926');
    expect(listings[2].description).toBe('At Skroutz Last Mile , we believe that great decisions start with great insights.');
  });

  it('başlıksız ya da kodsuz kaydı atlar, beklenmeyen yükte boş liste döner', () => {
    expect(parseWorkable({ jobs: [{ shortcode: 'A1', title: '  ' }, { title: 'Kodsuz ilan' }, { shortcode: 'B2', title: ' Geçerli ', published_on: 'tarih değil' }] })).toEqual([
      expect.objectContaining({ externalId: 'B2', title: 'Geçerli', url: 'https://apply.workable.com/j/B2', postedAt: null, locationText: null }),
    ]);
    expect(parseWorkable(null)).toEqual([]);
    expect(parseWorkable({ jobs: 'yok' })).toEqual([]);
  });
});

describe('SmartRecruiters ilan ayrıştırma', () => {
  const listings = parseSmartRecruiters(fixtureJson('smartrecruiters.json'));

  it('ilan numarasını kimlik yapar, başlığı kırpar ve kamuya açık ilan adresini üretir', () => {
    expect(listings.map((l) => l.externalId)).toEqual(['744000155328684', '744000155328334', '744000155268704']);
    expect(listings[2].title).toBe('Workshop Sales Representative - Washington DC Area');
    expect(listings[0].url).toBe('https://jobs.smartrecruiters.com/BoschGroup/744000155328684');
    expect(listings[0].applyUrl).toBe(listings[0].url);
  });

  it('konum metnini ve hibrit/uzaktan bayraklarını eşler', () => {
    expect(listings.map((l) => l.locationText)).toEqual(['Celaya, Gto., Mexico', 'Campinas, SP, Brazil', 'Washington, DC, United States | Remote']);
    expect(listings.map((l) => l.workMode)).toEqual(['unknown', 'hybrid', 'remote']);
  });

  it('yayın tarihini ve referans numarasını verir', () => {
    expect(iso(listings[0].postedAt)).toBe('2026-10-13T17:58:50.319Z');
    expect(listings[0].requisitionId).toBe('REF298318S');
  });

  it('tam konum metni yoksa şehir, bölge ve ülke kodunu birleştirir', () => {
    const [listing] = parseSmartRecruiters({ content: [{ id: 1, name: 'Mühendis', location: { city: 'İstanbul', region: 'İstanbul', country: 'tr' } }, { id: 2, name: '' }] });
    expect(listing).toMatchObject({ externalId: '1', locationText: 'İstanbul, TR', url: null, requisitionId: null });
  });
});

describe('SmartRecruiters sayfalama', () => {
  const page = (count: number, offset: number, totalFound: number) => ({
    offset,
    limit: 100,
    totalFound,
    content: Array.from({ length: count }, (_, i) => ({ id: `${offset + i}`, name: `İlan ${offset + i}`, company: { identifier: 'Firma' } })),
  });

  it('toplam sayıya ulaşana kadar sayfaları gezer ve taramayı eksiksiz sayar', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(page(100, 0, 250))).mockResolvedValueOnce(okResponse(page(100, 100, 250))).mockResolvedValueOnce(okResponse(page(50, 200, 250)));
    const result = await smartRecruitersConnector.collect(source({ company: 'Firma' }));
    expect(result).toMatchObject({ state: 'ok', complete: true, pages: 3, httpStatus: 200, sourceUrl: 'https://api.smartrecruiters.com/v1/companies/Firma/postings?limit=100&offset=0' });
    expect(result.listings).toHaveLength(250);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.smartrecruiters.com/v1/companies/Firma/postings?limit=100&offset=0',
      'https://api.smartrecruiters.com/v1/companies/Firma/postings?limit=100&offset=100',
      'https://api.smartrecruiters.com/v1/companies/Firma/postings?limit=100&offset=200',
    ]);
  });

  it('sayfa sınırına takılırsa taramayı eksik işaretler', async () => {
    fetchMock.mockImplementation(async (url) => okResponse(page(100, Number(new URL(url).searchParams.get('offset')), 4986)));
    const result = await smartRecruitersConnector.collect(source({ company: 'Firma' }));
    expect(result).toMatchObject({ state: 'ok', complete: false, pages: 5 });
    expect(result.listings).toHaveLength(500);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('sayfa hatasını kaynak durumuna yansıtır, firma ayarı yoksa istek atmaz', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(page(100, 0, 250))).mockResolvedValueOnce({ state: 'rate_limited', status: 429, retryAfterSeconds: 30 });
    expect(await smartRecruitersConnector.collect(source({ company: 'Firma' }))).toMatchObject({ state: 'rate_limited', complete: false, listings: [], retryAfterSeconds: 30 });
    fetchMock.mockClear();
    expect(await smartRecruitersConnector.collect(source({}))).toMatchObject({ state: 'error', complete: false, listings: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Recruitee ilan ayrıştırma', () => {
  const listings = parseRecruitee(fixtureJson('recruitee.json'));

  it('ilan numarasını kimlik yapar; kariyer sitesi ve başvuru bağlantılarını eşler', () => {
    expect(listings.map((l) => l.externalId)).toEqual(['2781634', '2769628', '1968676']);
    expect(listings[0].title).toBe('(Senior) Product Owner');
    expect(listings[0].url).toBe('https://careers.bunq.com/o/senior-product-owner-1');
    expect(listings[0].applyUrl).toBe('https://careers.bunq.com/o/senior-product-owner-1/c/new');
  });

  it('tüm konumları birleştirir; hibrit, uzaktan ve ofis bayraklarını eşler', () => {
    expect(listings[0].locationText).toBe('Amsterdam, Noord-Holland, Netherlands');
    expect(listings[1].locationText).toBe('Yerevan, Erevan, Armenia | Istanbul, İstanbul, Türkiye | London, Greater London, United Kingdom | Remote');
    expect(listings[2].locationText).toBe('Berlin, Deutschland');
    expect(listings.map((l) => l.workMode)).toEqual(['hybrid', 'remote', 'onsite']);
  });

  it('"UTC" ekli tarihleri çözer, yayındaki ilanı kapalı işaretlemez', () => {
    expect(iso(listings[1].postedAt)).toBe('2026-10-02T14:37:16.000Z');
    expect(iso(listings[1].updatedAt)).toBe('2026-10-08T08:03:56.000Z');
    expect(listings.every((l) => l.closedMarker === false)).toBe(true);
    expect(listings[0].description).toContain("At bunq, we're not just building a banking app");
    expect(listings[0].description).not.toContain('<');
  });

  it('kapatılmış ilanı işaretler, konum listesi yoksa üst düzey alanları kullanır', () => {
    const [listing] = parseRecruitee({ offers: [{ id: 7, title: 'Kapanan ilan', status: 'closed', city: 'İzmir', country: 'Türkiye', remote: true }, { id: 8 }] });
    expect(listing).toMatchObject({ externalId: '7', closedMarker: true, locationText: 'İzmir, Türkiye | Remote', workMode: 'remote', url: null, postedAt: null });
  });
});

describe('Ashby ilan ayrıştırma', () => {
  const listings = parseAshby(fixtureJson('ashby.json'));

  it('ilan kimliğini, kırpılmış başlığı ve bağlantıları eşler', () => {
    expect(listings.map((l) => l.externalId)).toEqual(['34413f8d-26bf-4bbc-8ade-eb309a0e2245', 'd1183b00-6590-4fe4-a585-28d84e578fe3', '3f94674f-6af8-4e10-9631-77b1b0a410bf']);
    expect(listings[0].title).toBe('Security Engineer, Cloud');
    expect(listings[0].url).toBe('https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245');
    expect(listings[0].applyUrl).toBe('https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245/application');
  });

  it('ek konumları ekler; çalışma şeklini isRemote yerine workplaceType alanından alır', () => {
    expect(listings[0].locationText).toBe('New York, NY (HQ) | Remote (Canada) | Remote (US) | Miami, FL');
    expect(listings[1].locationText).toBe('New York, NY (HQ) | San Francisco, CA | Remote (US)');
    expect(listings[2].locationText).toBe('Toronto, ON');
    expect(listings.map((l) => l.workMode)).toEqual(['hybrid', 'remote', 'onsite']);
  });

  it('yayın tarihini ve düz metin açıklamayı verir', () => {
    expect(iso(listings[0].postedAt)).toBe('2026-04-07T17:12:35.753Z');
    expect(listings[0].description).toContain('Ramp is building the smart infrastructure for finance teams');
    expect(listings.every((l) => l.closedMarker === false)).toBe(true);
  });

  it('workplaceType boşsa isRemote bayrağına bakar, listeden kaldırılan ilanı kapalı işaretler', () => {
    const parsed = parseAshby({
      jobs: [
        { id: 'a', title: 'Uzaktan', isRemote: true, workplaceType: null, address: { postalAddress: { addressLocality: 'İstanbul', addressCountry: 'Türkiye' } } },
        { id: 'b', title: 'Gizli', isListed: false, descriptionHtml: '<p>Yalnızca <b>HTML</b></p>' },
        { id: 'c', title: '' },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ workMode: 'remote', locationText: 'İstanbul, Türkiye | Remote', closedMarker: false });
    expect(parsed[1]).toMatchObject({ workMode: 'unknown', locationText: null, closedMarker: true, description: 'Yalnızca HTML' });
  });
});

describe('Teamtailor akışı ayrıştırma', () => {
  const listings = parseTeamtailor(fixtureText('teamtailor.xml'));

  it('guid değerini kimlik yapar; ilan ve başvuru bağlantılarını eşler', () => {
    expect(listings.map((l) => l.externalId)).toEqual(['a899dbe3-8727-4e13-a3bc-b5f8513385d6', '8cf0763f-c3fb-4372-b6af-d68030cd39c0', 'ae49769c-e313-46a0-9baa-5f86c5a35f18']);
    expect(listings[0].title).toBe('Senior Customs Operations Specialist');
    expect(listings[0].url).toBe('https://polestar.teamtailor.com/jobs/8476851-senior-customs-operations-specialist');
    expect(listings[0].applyUrl).toBe('https://polestar.teamtailor.com/jobs/8476851-senior-customs-operations-specialist/applications/new');
    expect(listings[2].url).toBe('https://jobb.oddwork.se/jobs/8082074-saljare-inom-restaurangbranschen-till-ordine-malmo-helsingborg-eller-lund');
  });

  it('konumu şehir ve ülke olarak verir; remoteStatus değerini çalışma şekline çevirir', () => {
    expect(listings.map((l) => l.locationText)).toEqual(['Göteborg, Sweden', 'Göteborg, Sweden', 'Malmö, Sweden | Remote']);
    expect(listings.map((l) => l.workMode)).toEqual(['onsite', 'hybrid', 'remote']);
  });

  it('yayın tarihini saat dilimiyle çözer, kaçışlı HTML açıklamayı sade metne çevirir', () => {
    expect(iso(listings[0].postedAt)).toBe('2026-09-30T07:33:49.000Z');
    expect(listings[0].description).toBe('The opportunity We are looking for a Senior Customs Operations Specialist to join Polestar’s Global Customs team within the Quality & Logistics organization.');
  });

  it('remoteStatus "none" ise çalışma şekli bilinmez; başlıksız öğe atlanır', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:tt="https://teamtailor.com/locations"><channel>
      <item><title>Depo Sorumlusu</title><link>https://firma.teamtailor.com/jobs/1-depo/</link><remoteStatus>none</remoteStatus><guid>g-1</guid>
        <tt:locations><tt:location><tt:name>Merkez</tt:name><tt:city/><tt:country/></tt:location><tt:location><tt:name>Ankara</tt:name><tt:city>Ankara</tt:city><tt:country>Türkiye</tt:country></tt:location></tt:locations></item>
      <item><title></title><guid>g-2</guid></item>
    </channel></rss>`;
    expect(parseTeamtailor(xml)).toEqual([
      expect.objectContaining({ externalId: 'g-1', workMode: 'unknown', locationText: 'Merkez | Ankara, Türkiye', applyUrl: 'https://firma.teamtailor.com/jobs/1-depo/applications/new', postedAt: null, description: null }),
    ]);
    expect(parseTeamtailor('')).toEqual([]);
  });
});

describe('Personio akışı ayrıştırma', () => {
  const listings = parsePersonio(fixtureText('personio.xml'), 'everphone.jobs.personio.de');

  it('pozisyon numarasını kimlik yapar; adresleri kariyer sitesinin alan adından üretir', () => {
    expect(listings.map((l) => l.externalId)).toEqual(['2019718', '2825215', '1834171']);
    expect(listings[0].title).toBe('Account Executive (w/m/d)');
    expect(listings[1].title).toBe("Founder's Associate – AI-Driven Sales (w/m/d)");
    expect(listings[0].url).toBe('https://everphone.jobs.personio.de/job/2019718');
    expect(listings[0].applyUrl).toBe('https://everphone.jobs.personio.de/job/2019718/apply');
  });

  it('ofisi ve ek ofisleri konum metnine yazar; çalışma şekli akışta olmadığı için bilinmez', () => {
    expect(listings[0].locationText).toBe('Berlin Köpenicker Straße 154, 10997 Berlin');
    expect(listings[2].locationText).toBe('Munich | Berlin');
    expect(listings.map((l) => l.workMode)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('oluşturma tarihini ve bölüm başlıklarıyla açıklamayı verir', () => {
    expect(iso(listings[0].postedAt)).toBe('2025-03-17T16:54:49.000Z');
    expect(listings[0].description).toContain('Über die Rolle\nDie meisten Unternehmen kaufen ihre Geräte noch.');
    expect(listings[0].description).not.toContain('<');
    expect(listings[2].description).toBeNull();
  });

  it('alan adı verilmezse adres üretmez; ofis adı uzaktan diyorsa işaretler', () => {
    expect(parsePersonio(fixtureText('personio.xml'))[0]).toMatchObject({ url: null, applyUrl: null });
    const xml = '<workzag-jobs><position><id>5</id><office>Remote - Türkiye</office><name>Destek Uzmanı</name></position><position><id>6</id><name></name></position></workzag-jobs>';
    expect(parsePersonio(xml, 'firma.jobs.personio.com')).toEqual([expect.objectContaining({ externalId: '5', workMode: 'remote', locationText: 'Remote - Türkiye', url: 'https://firma.jobs.personio.com/job/5' })]);
  });
});

describe('ATS bağlayıcıları — toplama ve doğrulama', () => {
  it('altı bağlayıcı aynı sözleşmeyle tanımlıdır', () => {
    expect(ATS_CONNECTORS.map((c) => c.kind)).toEqual(['workable', 'smartrecruiters', 'recruitee', 'ashby', 'teamtailor', 'personio']);
    for (const c of ATS_CONNECTORS) {
      expect(c.extractorVersion).toBe(`${c.kind}@1`);
      expect(c).toMatchObject({ capabilities: ['discover', 'detail', 'verify'], accessMode: 'api', defaultIntervalMinutes: 30, minIntervalMinutes: 10, applyChannel: 'ats_form', isOfficial: true });
      expect(c.label).toBeTruthy();
    }
  });

  it('Workable: hesap adresini çağırır, etag ve içerik özetini döndürür', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(fixtureJson('workable.json'), { headers: { etag: 'W/"abc"' } }));
    const result = await workableConnector.collect(source({ account: 'blueground' }, 'W/"eski"'));
    expect(fetchMock).toHaveBeenCalledWith('https://apply.workable.com/api/v1/widget/accounts/blueground?details=true', { 'if-none-match': 'W/"eski"' });
    expect(result).toMatchObject({ state: 'ok', complete: true, pages: 1, httpStatus: 200, etag: 'W/"abc"', sourceUrl: 'https://apply.workable.com/api/v1/widget/accounts/blueground?details=true' });
    expect(result.contentHash).toBeTruthy();
    expect(result.listings).toHaveLength(3);
  });

  it('değişmemiş yanıt eksiksiz sayılır; erişim hatası ve bozuk yük kapanış kanıtı üretmez', async () => {
    fetchMock.mockResolvedValueOnce({ state: 'not_modified', status: 304 });
    expect(await recruiteeConnector.collect(source({ company: 'bunq' }, '"e1"'))).toMatchObject({ state: 'not_modified', complete: true, listings: [], sourceUrl: 'https://bunq.recruitee.com/api/offers/' });
    fetchMock.mockResolvedValueOnce({ state: 'not_found', status: 404 });
    expect(await ashbyConnector.collect(source({ org: 'yok' }))).toMatchObject({ state: 'not_found', complete: false, listings: [], httpStatus: 404 });
    fetchMock.mockResolvedValueOnce(okResponse('<html>json değil</html>'));
    const broken = await workableConnector.collect(source({ account: 'blueground' }));
    expect(broken).toMatchObject({ state: 'error', complete: false, listings: [] });
    expect(broken.error).toMatch(/^Ayrıştırma hatası/);
  });

  it('akış yerine HTML dönerse boş liste yerine hata bildirir', async () => {
    fetchMock.mockResolvedValue(okResponse('<!doctype html><html><body>Kariyer</body></html>'));
    expect(await teamtailorConnector.collect(source({ host: 'firma.teamtailor.com' }))).toMatchObject({ state: 'error', complete: false, listings: [], sourceUrl: 'https://firma.teamtailor.com/jobs.rss' });
    expect(await personioConnector.collect(source({ host: 'https://firma.jobs.personio.de/' }))).toMatchObject({ state: 'error', complete: false, listings: [], sourceUrl: 'https://firma.jobs.personio.de/xml' });
  });

  it('akış bağlayıcıları ilanları toplar; geçersiz alan adıyla istek atmaz', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(fixtureText('teamtailor.xml'), { headers: { etag: 'W/"t1"', 'last-modified': 'Tue, 13 Oct 2026 14:09:33 GMT' } }));
    expect(await teamtailorConnector.collect(source({ host: 'polestar.teamtailor.com' }))).toMatchObject({ state: 'ok', complete: true, etag: 'W/"t1"', lastModified: 'Tue, 13 Oct 2026 14:09:33 GMT', listings: expect.arrayContaining([expect.objectContaining({ externalId: 'a899dbe3-8727-4e13-a3bc-b5f8513385d6' })]) });
    fetchMock.mockResolvedValueOnce(okResponse(fixtureText('personio.xml')));
    const personio = await personioConnector.collect(source({ host: 'everphone.jobs.personio.de' }));
    expect(personio.listings.map((l) => l.url)).toEqual(['https://everphone.jobs.personio.de/job/2019718', 'https://everphone.jobs.personio.de/job/2825215', 'https://everphone.jobs.personio.de/job/1834171']);
    fetchMock.mockClear();
    expect(await teamtailorConnector.collect(source({ host: 'bir alan adı değil' }))).toMatchObject({ state: 'error', complete: false });
    expect(await personioConnector.collect(source({ host: 'localhost' }))).toMatchObject({ state: 'error', complete: false });
    expect(await recruiteeConnector.collect(source({ company: 'evil.example/#' }))).toMatchObject({ state: 'error', complete: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ilan detayını doğrular: 404 bulunamadı, erişim hatası belirsiz, açık kayıt açık', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ shortcode: '186545F8C1', state: 'published' }));
    expect(await workableConnector.verify(source({ account: 'blueground' }), '186545F8C1')).toBe('open');
    expect(fetchMock).toHaveBeenLastCalledWith('https://apply.workable.com/api/v2/accounts/blueground/jobs/186545F8C1');
    fetchMock.mockResolvedValueOnce({ state: 'not_found', status: 404 });
    expect(await workableConnector.verify(source({ account: 'blueground' }), 'YOK')).toBe('not_found');
    fetchMock.mockResolvedValueOnce({ state: 'rate_limited', status: 429 });
    expect(await smartRecruitersConnector.verify(source({ company: 'BoschGroup' }), '1')).toBe('unavailable');
    fetchMock.mockResolvedValueOnce(okResponse({ id: '1', active: false }));
    expect(await smartRecruitersConnector.verify(source({ company: 'BoschGroup' }), '1')).toBe('closed');
    expect(fetchMock).toHaveBeenLastCalledWith('https://api.smartrecruiters.com/v1/companies/BoschGroup/postings/1');
    fetchMock.mockResolvedValueOnce(okResponse({ offer: { id: 2781634, status: 'published' } }));
    expect(await recruiteeConnector.verify(source({ company: 'bunq' }), '2781634')).toBe('open');
    expect(fetchMock).toHaveBeenLastCalledWith('https://bunq.recruitee.com/api/offers/2781634');
  });

  it('Ashby doğrulaması ilanı pano yanıtında arar', async () => {
    fetchMock.mockResolvedValue(okResponse(fixtureJson('ashby.json')));
    expect(await ashbyConnector.verify(source({ org: 'ramp' }), 'd1183b00-6590-4fe4-a585-28d84e578fe3')).toBe('open');
    expect(await ashbyConnector.verify(source({ org: 'ramp' }), '00000000-0000-4000-8000-000000000000')).toBe('not_found');
    expect(fetchMock).toHaveBeenLastCalledWith('https://api.ashbyhq.com/posting-api/job-board/ramp', {}, { maxBytes: BOARD_API_MAX_BYTES });
    fetchMock.mockResolvedValue({ state: 'blocked', error: 'Yanıt boyutu sınırı aşıldı' });
    expect(await ashbyConnector.verify(source({ org: 'ramp' }), 'd1183b00-6590-4fe4-a585-28d84e578fe3')).toBe('unavailable');
  });

  it('akış bağlayıcıları ilan sayfasını doğrular; başka sayfaya yönlenen yanıtı açık saymaz', async () => {
    const posting = 'https://polestar.teamtailor.com/jobs/8476851-senior-customs-operations-specialist';
    fetchMock.mockResolvedValueOnce(okResponse('<html></html>', { url: posting }));
    expect(await teamtailorConnector.verify(source({ host: 'polestar.teamtailor.com' }), 'guid', posting)).toBe('open');
    fetchMock.mockResolvedValueOnce(okResponse('<html></html>', { url: 'https://polestar.teamtailor.com/jobs' }));
    expect(await teamtailorConnector.verify(source({ host: 'polestar.teamtailor.com' }), 'guid', posting)).toBe('unavailable');
    fetchMock.mockResolvedValueOnce({ state: 'not_found', status: 404 });
    expect(await teamtailorConnector.verify(source({ host: 'polestar.teamtailor.com' }), 'guid', posting)).toBe('not_found');
    expect(await teamtailorConnector.verify(source({ host: 'polestar.teamtailor.com' }), 'guid', null)).toBe('unavailable');

    fetchMock.mockResolvedValueOnce(okResponse('<html></html>', { url: 'https://everphone.jobs.personio.de/job/2019718?language=de' }));
    expect(await personioConnector.verify(source({ host: 'everphone.jobs.personio.de' }), '2019718')).toBe('open');
    expect(fetchMock).toHaveBeenLastCalledWith('https://everphone.jobs.personio.de/job/2019718');
    fetchMock.mockResolvedValueOnce(okResponse('<html></html>', { url: 'https://everphone.jobs.personio.de/' }));
    expect(await personioConnector.verify(source({ host: 'everphone.jobs.personio.de' }), '2019718')).toBe('unavailable');
    fetchMock.mockResolvedValueOnce({ state: 'not_found', status: 404 });
    expect(await personioConnector.verify(source({ host: 'everphone.jobs.personio.de' }), '999999999')).toBe('not_found');
  });
});

describe('ATS bağlantısı tanıma', () => {
  it('Greenhouse ve Lever panolarını küçük harfli mevcut anahtarlarla verir', () => {
    expect(detectAtsSource('https://boards.greenhouse.io/Acme')).toEqual({ kind: 'greenhouse', config: { boardToken: 'acme' } });
    expect(detectAtsSource('https://job-boards.greenhouse.io/acme/jobs/4012345')).toEqual({ kind: 'greenhouse', config: { boardToken: 'acme' } });
    expect(detectAtsSource('https://boards.greenhouse.io/embed/job_board?for=Acme')).toEqual({ kind: 'greenhouse', config: { boardToken: 'acme' } });
    expect(detectAtsSource('https://jobs.lever.co/Acme/1f3a0c1e-0000-4000-8000-000000000000')).toEqual({ kind: 'lever', config: { site: 'acme' } });
    expect(detectAtsSource('jobs.lever.co/acme')).toEqual({ kind: 'lever', config: { site: 'acme' } });
  });

  it('Workable hesabını yol ya da alt alan adından çıkarır', () => {
    expect(detectAtsSource('https://apply.workable.com/blueground/j/186545F8C1/')).toEqual({ kind: 'workable', config: { account: 'blueground' } });
    expect(detectAtsSource('https://apply.workable.com/Blueground')).toEqual({ kind: 'workable', config: { account: 'blueground' } });
    expect(detectAtsSource('https://blueground.workable.com/jobs/123')).toEqual({ kind: 'workable', config: { account: 'blueground' } });
  });

  it('SmartRecruiters, Recruitee ve Ashby panolarını tanır', () => {
    expect(detectAtsSource('https://jobs.smartrecruiters.com/BoschGroup/744000155328684-electronic-supplier-quality-engineer')).toEqual({ kind: 'smartrecruiters', config: { company: 'BoschGroup' } });
    expect(detectAtsSource('https://careers.smartrecruiters.com/BoschGroup')).toEqual({ kind: 'smartrecruiters', config: { company: 'BoschGroup' } });
    expect(detectAtsSource('https://bunq.recruitee.com/o/senior-product-owner-1')).toEqual({ kind: 'recruitee', config: { company: 'bunq' } });
    expect(detectAtsSource('https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245')).toEqual({ kind: 'ashby', config: { org: 'ramp' } });
    expect(detectAtsSource('https://jobs.ashbyhq.com/Flock%20Safety')).toEqual({ kind: 'ashby', config: { org: 'Flock Safety' } });
  });

  it('Teamtailor ve Personio için tam alan adını verir', () => {
    expect(detectAtsSource('https://polestar.teamtailor.com/jobs/8476851-senior-customs-operations-specialist')).toEqual({ kind: 'teamtailor', config: { host: 'polestar.teamtailor.com' } });
    expect(detectAtsSource('https://Career.Teamtailor.com/jobs')).toEqual({ kind: 'teamtailor', config: { host: 'career.teamtailor.com' } });
    expect(detectAtsSource('https://everphone.jobs.personio.de/job/2019718?language=de')).toEqual({ kind: 'personio', config: { host: 'everphone.jobs.personio.de' } });
    expect(detectAtsSource('https://userlane.jobs.personio.com/')).toEqual({ kind: 'personio', config: { host: 'userlane.jobs.personio.com' } });
  });

  it('firma sitesini, bozuk bağlantıyı ve http dışı şemaları tanımaz', () => {
    for (const link of ['https://www.firma.com.tr/kariyer', 'https://careers.bunq.com/o/senior-product-owner-1', 'bu bir bağlantı değil', '', '   ', 'http://', 'https://', 'javascript:alert(1)', 'mailto:ik@firma.com', 'ftp://jobs.lever.co/acme'])
      expect(detectAtsSource(link)).toBeNull();
    expect(detectAtsSource(null as unknown as string)).toBeNull();
    expect(detectAtsSource(undefined as unknown as string)).toBeNull();
  });

  it('firma adı taşımayan genel adresleri kaynak saymaz', () => {
    for (const link of [
      'https://boards.greenhouse.io/',
      'https://jobs.lever.co',
      'https://www.workable.com/',
      'https://apply.workable.com',
      'https://apply.workable.com/j/186545F8C1',
      'https://jobs.workable.com/view/abc',
      'https://careers.smartrecruiters.com/',
      'https://jobs.smartrecruiters.com/oneclick-ui/company/BoschGroup/publication/1',
      'https://www.recruitee.com/pricing',
      'https://app.recruitee.com/login',
      'https://api.recruitee.com/c/1/offers',
      'https://jobs.ashbyhq.com/',
      'https://jobs.ashbyhq.com/api/non-user-graphql',
      'https://www.teamtailor.com/en/',
      'https://app.teamtailor.com/companies',
      'https://api.teamtailor.com/v1/jobs',
      'https://www.personio.de/',
      'https://jobs.personio.de/',
      'https://api.jobs.personio.de/xml',
    ])
      expect(detectAtsSource(link)).toBeNull();
  });
});

describe('ATS pano adresi', () => {
  const samples: [string, string, string][] = [
    ['https://boards.greenhouse.io/acme/jobs/1', 'boards.greenhouse.io', 'https://boards.greenhouse.io/acme'],
    ['https://job-boards.greenhouse.io/acme', 'boards.greenhouse.io', 'https://boards.greenhouse.io/acme'],
    ['https://jobs.lever.co/acme/abc', 'jobs.lever.co', 'https://jobs.lever.co/acme'],
    ['https://blueground.workable.com', 'apply.workable.com', 'https://apply.workable.com/blueground'],
    ['https://careers.smartrecruiters.com/BoschGroup', 'jobs.smartrecruiters.com', 'https://jobs.smartrecruiters.com/BoschGroup'],
    ['https://bunq.recruitee.com/o/senior-product-owner-1', 'bunq.recruitee.com', 'https://bunq.recruitee.com'],
    ['https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245', 'jobs.ashbyhq.com', 'https://jobs.ashbyhq.com/ramp'],
    ['https://polestar.teamtailor.com/jobs/8476851-senior-customs-operations-specialist', 'polestar.teamtailor.com', 'https://polestar.teamtailor.com/jobs'],
    ['https://everphone.jobs.personio.de/job/2019718', 'everphone.jobs.personio.de', 'https://everphone.jobs.personio.de'],
  ];

  it('tanınan bağlantıdan üretilen pano adresi beklenen alan adında geçerli bir adrestir', () => {
    for (const [link, host, board] of samples) {
      const detected = detectAtsSource(link)!;
      const built = atsBoardLink(detected.kind, detected.config);
      expect(built).toBe(board);
      expect(new URL(built!).hostname).toBe(host);
      expect(detectAtsSource(built!)).toEqual(detected);
    }
  });

  it('boşluklu pano adını kodlar, yazılmış şema ve yolu alan adından ayıklar', () => {
    expect(atsBoardLink('ashby', { org: 'Flock Safety' })).toBe('https://jobs.ashbyhq.com/Flock%20Safety');
    expect(atsBoardLink('teamtailor', { host: 'https://Polestar.teamtailor.com/jobs' })).toBe('https://polestar.teamtailor.com/jobs');
    expect(atsBoardLink('personio', { host: ' everphone.jobs.personio.de ' })).toBe('https://everphone.jobs.personio.de');
  });

  it('bilinmeyen tür, eksik ya da geçersiz ayar için null döner', () => {
    expect(atsBoardLink('career_page', { url: 'https://firma.com/kariyer' })).toBeNull();
    expect(atsBoardLink('constructor', { site: 'acme' })).toBeNull();
    expect(atsBoardLink('lever', {})).toBeNull();
    expect(atsBoardLink('lever', { site: '  ' })).toBeNull();
    expect(atsBoardLink('lever', { site: 42 })).toBeNull();
    expect(atsBoardLink('greenhouse', null)).toBeNull();
    expect(atsBoardLink('workable', 'blueground')).toBeNull();
    expect(atsBoardLink('recruitee', { company: 'evil.example/#' })).toBeNull();
    expect(atsBoardLink('teamtailor', { host: 'localhost' })).toBeNull();
    expect(atsBoardLink('personio', { host: 'bir alan adı değil' })).toBeNull();
  });
});
