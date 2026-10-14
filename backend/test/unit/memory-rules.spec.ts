import { addressFeatures, addressSourceType, deliveryEffectOf, localPartClass, strongestEffect } from '../../src/domain/address-book';
import { CatalogFacts, CatalogJob, catalogKeyOf, catalogRegion, matchCatalogCompany, mergeCatalog, mergeCatalogJobs, pastJobsFor } from '../../src/domain/catalog';
import { employeeRangeOf, employeeSizeOf, parseEmployees } from '../../src/domain/company-size';
import { validateAiOutput } from '../../src/engine/ai/validate';
import { careersLinkOfSource } from '../../src/engine/connectors/defaults';

describe('çalışan sayısı', () => {
  it('sayıyı aralığa yerleştirir', () => {
    expect([1, 10, 11, 50, 51, 200, 201, 500, 501, 1000, 1001, 5000, 5001, 90000].map(employeeRangeOf)).toEqual([
      '1-10', '1-10', '11-50', '11-50', '51-200', '51-200', '201-500', '201-500', '501-1000', '501-1000', '1001-5000', '1001-5000', '5001+', '5001+',
    ]);
  });

  it('LinkedIn aralıklarını ve binlik ayraçlarını okur', () => {
    expect(parseEmployees('51-200')).toEqual({ range: '51-200', count: null });
    expect(parseEmployees('2-10 çalışan')).toEqual({ range: '1-10', count: null });
    expect(parseEmployees('1.001-5.000 employees')).toEqual({ range: '1001-5000', count: null });
    expect(parseEmployees('5,001-10,000')).toEqual({ range: '5001+', count: null });
    expect(parseEmployees('11 – 50')).toEqual({ range: '11-50', count: null });
    expect(parseEmployees('500 to 1000')).toEqual({ range: '501-1000', count: null });
  });

  it('"N+" bir üst dilime, tek sayı kendi dilimine düşer', () => {
    expect(parseEmployees('10.000+')).toEqual({ range: '5001+', count: null });
    expect(parseEmployees('500+')).toEqual({ range: '501-1000', count: null });
    expect(parseEmployees('1000 ve üzeri')).toEqual({ range: '1001-5000', count: null });
    expect(parseEmployees('yaklaşık 350')).toEqual({ range: '201-500', count: 350 });
    expect(parseEmployees('1,2K')).toEqual({ range: '1001-5000', count: 1200 });
    expect(parseEmployees('12 bin')).toEqual({ range: '5001+', count: 12000 });
    expect(parseEmployees(42)).toEqual({ range: '11-50', count: 42 });
  });

  it('anlaşılamayan ya da birden fazla ilgisiz sayı içeren metni reddeder', () => {
    for (const text of ['', null, undefined, 'bilinmiyor', '2015 yılında 120 kişiyle', '0', '200-50', 999_999_999]) expect(parseEmployees(text)).toBeNull();
  });

  it('model çalışan sayısını bozuk biçimde verse de asıl çıktı reddedilmez', () => {
    const contacts = [{ email: 'ik@firma.com', sourceUrl: 'https://firma.com/kariyer' }];
    const employeesOf = (employees: unknown) => validateAiOutput('company_contacts', { contacts, offices: [], employees });
    expect(employeesOf(350)).toMatchObject({ ok: true, output: { employees: '350', contacts } });
    expect(employeesOf('x'.repeat(200)).output.employees).toHaveLength(60);
    expect(employeesOf({ min: 51, max: 200 })).toMatchObject({ ok: true, output: { employees: null, contacts } });
    expect(validateAiOutput('company_contacts', { contacts, offices: [] })).toMatchObject({ ok: true, output: { contacts } });
    expect(validateAiOutput('company_sizes', { sizes: [{ ref: 'C1', employees: 42 }, { employees: '11-50' }] })).toMatchObject({ ok: true, output: { sizes: [{ ref: 'C1', employees: '42' }] } });
  });

  it('kayıttaki aralık geçersizse boyut bilinmiyor sayılır', () => {
    expect(employeeSizeOf({ employeeRange: '51-200', employeeCount: 120 })).toEqual({ range: '51-200', count: 120 });
    expect(employeeSizeOf({ employeeRange: 'büyük', employeeCount: 5 })).toBeNull();
    expect(employeeSizeOf({ employeeRange: null, employeeCount: null })).toBeNull();
  });
});

describe('adres sicili kuralları', () => {
  it('adresin bulunduğu kaynağı türüne ayırır', () => {
    expect(addressSourceType('https://www.firma.com/iletisim', 'firma.com')).toBe('company_site');
    expect(addressSourceType('https://kariyer.firma.com/', 'firma.com')).toBe('careers_page');
    expect(addressSourceType('https://firma.com/insan-kaynaklari', 'firma.com')).toBe('careers_page');
    expect(addressSourceType('https://www.kariyer.net/is-ilani/firma-123', 'firma.com')).toBe('job_board');
    expect(addressSourceType('https://www.linkedin.com/posts/firma-ik', 'firma.com')).toBe('social');
    expect(addressSourceType('https://www.find.com.tr/firma', 'firma.com')).toBe('directory');
    expect(addressSourceType('https://haber.example/firma-buyuyor', 'firma.com')).toBe('other_site');
    expect(addressSourceType(null, 'firma.com')).toBe('unknown');
    expect(addressSourceType('adres değil', 'firma.com')).toBe('unknown');
  });

  it('yalnızca sunucunun kesin bildirdiği durumlar adresi kalıcı olarak geçersiz kılar', () => {
    expect(deliveryEffectOf('bad_address')).toMatchObject({ bounced: true, dead: 'address' });
    expect(deliveryEffectOf('closed_address')).toMatchObject({ bounced: true, dead: 'address' });
    expect(deliveryEffectOf('bad_domain')).toMatchObject({ bounced: true, dead: 'domain' });
    for (const temporary of ['mailbox_full', 'too_large', 'rejected', 'bounce_other', 'address_changed']) expect(deliveryEffectOf(temporary)).toMatchObject({ bounced: true, delivered: false, dead: null });
  });

  it('otomatik yanıt ve başka kanal isteği teslim, çalışan yanıtı teslim ve yanıt sayılır; belirsiz dönüş bilgi taşımaz', () => {
    for (const delivered of ['auto_reply', 'out_of_office', 'format_issue', 'apply_elsewhere']) expect(deliveryEffectOf(delivered)).toEqual({ delivered: true, bounced: false, replied: false, dead: null });
    for (const replied of ['human_reply', 'interview', 'rejection', 'do_not_contact']) expect(deliveryEffectOf(replied)).toMatchObject({ delivered: true, replied: true });
    for (const none of ['delayed', 'unknown', 'no_bounce', null, undefined]) expect(deliveryEffectOf(none)).toBeNull();
  });

  it('birden fazla dönüşte kesin olan öne geçer', () => {
    expect(strongestEffect(['auto_reply', 'human_reply'])?.category).toBe('human_reply');
    expect(strongestEffect(['human_reply', 'bad_address'])?.category).toBe('bad_address');
    expect(strongestEffect(['mailbox_full', 'auto_reply'])?.category).toBe('auto_reply');
    expect(strongestEffect(['delayed', null])).toBeNull();
  });

  it('öğrenme özellikleri: adres türü, yerel kısım, alan adı eşleşmesi ve kaynak', () => {
    expect(['kariyer@a.com', 'insankaynaklari@a.com', 'info@a.com', 'ayse.yilmaz@a.com', 'destek@a.com', 'x9@a.com'].map(localPartClass)).toEqual(['strong_hr', 'hr', 'general', 'person', 'non_hr', 'other']);
    expect(addressFeatures({ email: 'ik@firma.com', kind: 'official_hr', sourceUrl: 'https://firma.com/kariyer', verified: true }, { canonicalDomain: 'firma.com' })).toEqual({ kind: 'official_hr', local: 'strong_hr', domainMatch: true, sourceType: 'careers_page', verified: true });
  });
});

const job = (title: string, patch: Partial<CatalogJob> = {}): CatalogJob => ({ title, status: 'open', firstSeenAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-10-01T00:00:00.000Z', closedAt: null, url: null, location: null, ...patch });

function facts(patch: Partial<CatalogFacts> = {}): CatalogFacts {
  return {
    key: 'firma.com',
    name: 'Firma',
    normalizedName: 'firma',
    canonicalDomain: 'firma.com',
    website: 'https://firma.com',
    careersUrl: null,
    linkedinUrl: null,
    groupName: null,
    sectors: [],
    services: [],
    summary: null,
    employeeRange: null,
    employeeCount: null,
    cities: [],
    offices: [],
    sources: [],
    contacts: [],
    jobs: [],
    discoveredFor: [],
    researchedAt: null,
    contactsSearchedAt: null,
    officesSearchedAt: null,
    ...patch,
  };
}

const office = (city: string, district: string | null = null) => ({ label: 'Ofis', kind: 'office', city, district, address: null });
const profile = { exactTitles: ['Flutter Developer'], adjacentTitles: ['Mobile Developer'], excludedTitles: ['Intern'], excludedSectors: ['kumar'], city: 'İstanbul', districtsPrimary: ['Kadıköy', 'Üsküdar'], districtsConditional: [], allowRemote: false, allowHybrid: true };

describe('ortak katalog: birleştirme', () => {
  it('alan adı firmayı tanımlar; alan adı yoksa sadeleştirilmiş ad kullanılır', () => {
    expect(catalogKeyOf({ canonicalDomain: 'firma.com', normalizedName: 'firma' })).toBe('firma.com');
    expect(catalogKeyOf({ canonicalDomain: null, normalizedName: 'firma reklam' })).toBe('name:firma reklam');
    expect(catalogKeyOf({ canonicalDomain: null, normalizedName: 'ab' })).toBeNull();
  });

  it('ilk kayıtta listeler sınırlanır, şehirler ofislerden çıkar, aranan unvanlar sadeleşir', () => {
    const merged = mergeCatalog(null, facts({ offices: [office('İstanbul', 'Kadıköy'), office('istanbul', 'Şişli'), office('Ankara')], sectors: ['Fintech', 'fintech'] }), { discoveredFor: ['Kreatif Direktör', 'Creative Director'] });
    expect(merged.cities).toEqual(['İstanbul', 'Ankara']);
    expect(merged.sectors).toEqual(['Fintech']);
    expect(merged.discoveredFor).toEqual(['creative director']);
  });

  it('kimlik korunur, listeler birleşir, dolu gelen tekil bilgi öne geçer', () => {
    const existing = facts({ name: 'Firma A.Ş.', sectors: ['fintech'], employeeRange: '11-50', offices: [office('İstanbul')], cities: ['İstanbul'], summary: 'eski', discoveredFor: ['flutter developer'], researchedAt: new Date('2026-09-01') });
    const incoming = facts({ name: 'FIRMA', sectors: ['ödeme'], employeeRange: '51-200', employeeCount: 120, offices: [], summary: null, linkedinUrl: 'https://www.linkedin.com/company/firma', researchedAt: new Date('2026-10-01') });
    const merged = mergeCatalog(existing, incoming, { discoveredFor: ['iOS Developer'] });
    expect(merged).toMatchObject({ name: 'Firma A.Ş.', sectors: ['fintech', 'ödeme'], employeeRange: '51-200', employeeCount: 120, summary: 'eski', cities: ['İstanbul'], linkedinUrl: 'https://www.linkedin.com/company/firma', discoveredFor: ['flutter developer', 'ios developer'] });
    expect(merged.offices).toHaveLength(1);
    expect(merged.researchedAt).toEqual(new Date('2026-10-01'));
  });

  it('ada göre açılmış kayıt alan adı öğrenilince alan adına taşınır', () => {
    const merged = mergeCatalog(facts({ key: 'name:firma', canonicalDomain: null, website: null }), facts());
    expect(merged).toMatchObject({ key: 'firma.com', canonicalDomain: 'firma.com', website: 'https://firma.com' });
  });

  it('geçersizliği kesinleşen adres kataloğa girmez, girmişse çıkar', () => {
    const existing = facts({ contacts: [{ email: 'eski@firma.com', kind: 'official_hr', sourceUrl: null }, { email: 'ik@firma.com', kind: 'official_hr', sourceUrl: null }] });
    const incoming = facts({ contacts: [{ email: 'olu@firma.com', kind: 'general', sourceUrl: null }, { email: 'kariyer@firma.com', kind: 'official_hr', sourceUrl: 'https://firma.com/kariyer' }] });
    expect(mergeCatalog(existing, incoming, { dead: new Set(['eski@firma.com', 'olu@firma.com']) }).contacts.map((c) => c.email)).toEqual(['ik@firma.com', 'kariyer@firma.com']);
  });

  it('aynı unvanın en son görülen ilanı kalır, ilk görülme tarihi korunur', () => {
    const merged = mergeCatalogJobs([job('Flutter Developer', { firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-03-01T00:00:00.000Z' })], [job('flutter developer', { status: 'closed', lastSeenAt: '2026-09-01T00:00:00.000Z', closedAt: '2026-09-02T00:00:00.000Z' }), job('Muhasebe Uzmanı')]);
    expect(merged.map((j) => [j.title, j.status, j.firstSeenAt.slice(0, 10)])).toEqual([
      ['Muhasebe Uzmanı', 'open', '2026-09-01'],
      ['flutter developer', 'closed', '2026-01-01'],
    ]);
  });

  it('aynı panoya giden kaynak bir kez tutulur', () => {
    const merged = mergeCatalog(facts({ sources: [{ kind: 'lever', config: { site: 'firma' } }] }), facts({ sources: [{ kind: 'lever', config: { site: 'firma' } }, { kind: 'career_page', config: { url: 'https://firma.com/kariyer' } }, { kind: 'workable', config: { account: 'firma' } }] }));
    expect(merged.sources.map(careersLinkOfSource)).toEqual(['https://jobs.lever.co/firma', 'https://firma.com/kariyer', 'https://apply.workable.com/firma']);
  });
});

describe('ortak katalog: arama profiliyle eşleşme', () => {
  it('firmada görülen ilan en güçlü sinyaldir', () => {
    expect(matchCatalogCompany(profile, facts({ jobs: [job('Senior Flutter Developer')] }))).toMatchObject({ signal: 'job', title: 'exact' });
    expect(matchCatalogCompany(profile, facts({ jobs: [job('Mobile Developer (iOS)')] }))).toMatchObject({ signal: 'job', title: 'adjacent' });
  });

  it('ilan yoksa firmanın aynı unvan ailesi aranırken bulunmuş olması yeter', () => {
    expect(matchCatalogCompany(profile, facts({ discoveredFor: ['flutter developer'] }))).toMatchObject({ signal: 'discovered', title: 'exact' });
    expect(matchCatalogCompany(profile, facts({ discoveredFor: ['senior mobile developer'] }))).toMatchObject({ signal: 'discovered', title: 'adjacent' });
  });

  it('unvan sinyali yoksa, tek sözcüklük genel unvanla ya da hariç unvanla eşleşmez', () => {
    expect(matchCatalogCompany(profile, facts({ jobs: [job('Muhasebe Uzmanı')], discoveredFor: ['creative director'] }))).toBeNull();
    expect(matchCatalogCompany(profile, facts({ discoveredFor: ['developer'] }))).toBeNull();
    expect(matchCatalogCompany(profile, facts({ jobs: [job('Flutter Developer Intern')], discoveredFor: ['flutter developer intern'] }))).toBeNull();
  });

  it('hariç tutulan sektördeki ve başka şehirdeki firma önerilmez', () => {
    const matching = { discoveredFor: ['flutter developer'] };
    expect(matchCatalogCompany(profile, facts({ ...matching, sectors: ['Kumar'] }))).toBeNull();
    expect(matchCatalogCompany(profile, facts({ ...matching, offices: [office('Ankara')], cities: ['Ankara'] }))).toBeNull();
  });

  it('bölge: seçilen ilçede, aynı şehirde, bilinmiyor', () => {
    expect(catalogRegion(profile, { offices: [office('İstanbul', 'Kadıköy')], cities: ['İstanbul'] })).toBe('in');
    expect(catalogRegion(profile, { offices: [office('İstanbul', 'Şişli')], cities: ['İstanbul'] })).toBe('near');
    expect(catalogRegion(profile, { offices: [], cities: [] })).toBe('unknown');
    expect(catalogRegion(profile, { offices: [office('İzmir')], cities: ['İzmir'] })).toBe('out');
    expect(catalogRegion({ ...profile, city: null }, { offices: [office('İstanbul', 'Şişli')], cities: ['İstanbul'] })).toBe('near');
  });

  it('ilanlı ve bölgedeki firma daha yüksek puan alır', () => {
    const score = (c: CatalogFacts) => matchCatalogCompany(profile, c)!.score;
    const withJob = facts({ jobs: [job('Flutter Developer')], offices: [office('İstanbul', 'Kadıköy')], cities: ['İstanbul'] });
    const discoveredNear = facts({ discoveredFor: ['flutter developer'], offices: [office('İstanbul', 'Şişli')], cities: ['İstanbul'] });
    const discoveredUnknown = facts({ discoveredFor: ['mobile developer'] });
    expect(score(withJob)).toBeGreaterThan(score(discoveredNear));
    expect(score(discoveredNear)).toBeGreaterThan(score(discoveredUnknown));
  });

  it('yalnızca profille eşleşen kapanmış ilanlar geçmiş olarak taşınır', () => {
    const jobs = [job('Flutter Developer', { status: 'closed' }), job('Mobile Developer'), job('Muhasebe Uzmanı', { status: 'closed' }), job('Flutter Intern', { status: 'closed' })];
    expect(pastJobsFor(profile, jobs).map((j) => j.title)).toEqual(['Flutter Developer']);
  });
});
