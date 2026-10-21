import {
  domainCarriesName,
  genericGuess,
  mergeCandidates,
  needsReview,
  pageMentionsEmail,
  pickGenericGuesses,
  ResearchCandidate,
  roleGuessesFor,
  settleCandidate,
  SettleContext,
  settleProbedGuess,
  upgradesKind,
  websiteDomainFor,
} from '../../src/domain/contact-research';
import { recipientScore } from '../../src/domain/contacts';
import { contactReviewOutput, companyContactsOutput } from '../../src/engine/ai/schemas';
import { buildPrompt } from '../../src/engine/ai/prompts';

const published = (email: string, patch: Partial<ResearchCandidate> = {}): ResearchCandidate => ({ email, sourceUrl: 'https://firma.example/kariyer', origin: 'published', ...patch });
const ctx = (patch: Partial<SettleContext> = {}): SettleContext => ({ check: 'found', domainMatch: true, reviewed: false, ...patch });

describe('adres kaynağında geçiyor mu', () => {
  it('düz, mailto ve insanın okuyacağı gizlemeler tanınır', () => {
    expect(pageMentionsEmail('<a href="mailto:IK@Firma.example">yaz</a>', 'ik@firma.example')).toBe(true);
    expect(pageMentionsEmail('cv için ik [at] firma.example adresine', 'ik@firma.example')).toBe(true);
    expect(pageMentionsEmail('ik(at)firma(dot)example', 'ik@firma.example')).toBe(true);
    expect(pageMentionsEmail('ik&#64;firma.example', 'ik@firma.example')).toBe(true);
  });

  it('başka adres ya da yalnız alan adı yetmez', () => {
    expect(pageMentionsEmail('info@firma.example', 'ik@firma.example')).toBe(false);
    expect(pageMentionsEmail('firma.example kariyer', 'ik@firma.example')).toBe(false);
  });
});

describe('aday birleştirme ve denetim ihtiyacı', () => {
  it('aynı adres birleşir; en güçlü köken ve dolu alanlar korunur', () => {
    const merged = mergeCandidates([published('AYSE.KAYA@firma.example', { name: 'Ayşe Kaya', title: 'İK Uzmanı' }), { email: 'ayse.kaya@firma.example', sourceUrl: 'https://firma.example/ekip', origin: 'site' }]);
    expect(merged).toEqual([expect.objectContaining({ email: 'ayse.kaya@firma.example', origin: 'site', sourceUrl: 'https://firma.example/ekip', name: 'Ayşe Kaya', title: 'İK Uzmanı' })]);
  });

  it('kaynağında görülen firma alan adındaki rol adresi denetçiye gitmez; kişi, tahmin ve okunamayan kaynak gider', () => {
    expect(needsReview(published('kariyer@firma.example'), 'found', true)).toBe(false);
    expect(needsReview(published('kariyer@firma.example'), 'unreadable', true)).toBe(true);
    expect(needsReview(published('kariyer@baska.example'), 'found', false)).toBe(true);
    expect(needsReview(published('ayse.kaya@firma.example'), 'found', true)).toBe(true);
    expect(needsReview(published('kariyer@firma.example', { origin: 'pattern' }), 'found', true)).toBe(true);
  });
});

describe('adayın türü, rolü ve güveni', () => {
  it('kaynağında görülen İK adresi yüksek güvenle doğrulanmış kaydedilir', () => {
    expect(settleCandidate(published('ik@firma.example'), ctx())).toMatchObject({ kind: 'official_hr', roleType: 'hr', score: 85, verified: true });
  });

  it('kişisel adreste rol modelden gelir; İK çalışanı işe alım çalışanı sayılır', () => {
    const review = { keep: true, roleType: 'hr', confidence: 78 };
    expect(settleCandidate(published('ayse.kaya@firma.example', { roleType: 'employee' }), ctx({ reviewed: true, review }))).toMatchObject({ kind: 'named_recruiter', roleType: 'recruiting', score: 78, verified: false });
    expect(settleCandidate(published('can.demir@firma.example', { roleType: 'management', name: 'Can Demir', title: 'CTO' }), ctx({ reviewed: true, review: { keep: true, roleType: 'management', confidence: 70 } }))).toMatchObject({
      kind: 'management',
      name: 'Can Demir',
      title: 'CTO',
    });
  });

  it('denetçinin elediği aday kaydedilmez', () => {
    expect(settleCandidate(published('ali.veli@firma.example', { roleType: 'employee' }), ctx({ reviewed: true, review: { keep: false, confidence: 10 } }))).toBeNull();
  });

  it('tahmini adres ayrı türde ve en fazla 30 güvenle tutulur, asla doğrulanmış sayılmaz', () => {
    const settled = settleCandidate(published('ayse.kaya@firma.example', { origin: 'pattern', roleType: 'hr' }), ctx({ check: 'unreadable', reviewed: true, review: { keep: true, roleType: 'hr', confidence: 90 } }));
    expect(settled).toMatchObject({ kind: 'guessed', score: 30, verified: false });
  });

  it('kaynağında bulunamayan adres denetlenmediyse düşer, denetçi tutarsa 35 tavanında kalır', () => {
    expect(settleCandidate(published('ik@firma.example'), ctx({ check: 'missing' }))).toBeNull();
    expect(settleCandidate(published('ik@firma.example'), ctx({ check: 'missing', reviewed: true, review: { keep: true, confidence: 90 } }))).toMatchObject({ score: 35, verified: false });
  });

  it('denetlenmemiş kişisel adres düşük güvende kalır; kişisel posta servisindeki çalışan adresi alınmaz', () => {
    expect(settleCandidate(published('ali.veli@firma.example', { roleType: 'employee' }), ctx())?.score).toBe(40);
    expect(settleCandidate(published('ali.veli@gmail.com', { roleType: 'employee' }), ctx({ domainMatch: false, reviewed: true, review: { keep: true, confidence: 90 } }))).toBeNull();
  });

  it('destek, KVKK ve amacı belirsiz adresler alınmaz', () => {
    expect(settleCandidate(published('kvkk@firma.example', { roleType: 'hr' }), ctx())).toBeNull();
    expect(settleCandidate(published('x7@firma.example'), ctx())).toBeNull();
  });

  it('sosyal medyadan gelen başka alan adındaki rol adresi yalnız öneri olur', () => {
    expect(settleCandidate(published('ik@grup.example', { sourceUrl: 'https://www.linkedin.com/posts/x' }), ctx({ check: 'unreadable', domainMatch: false }))).toMatchObject({ kind: 'candidate_hr', score: 40 });
  });

  it('kayıtlı tür yalnızca yükseltilir', () => {
    expect(upgradesKind('other', 'employee')).toBe(true);
    expect(upgradesKind('guessed', 'management')).toBe(true);
    expect(upgradesKind('official_hr', 'employee')).toBe(false);
  });
});

describe('alıcı sırası', () => {
  it('rol adresleri kişisel adreslerin önünde; güven aynı türü sıralar', () => {
    const scoring = { domain: 'firma.example' };
    const general = recipientScore({ email: 'info@firma.example', kind: 'general' }, scoring);
    const manager = recipientScore({ email: 'can.demir@firma.example', kind: 'management', score: 100 }, scoring);
    const employee = recipientScore({ email: 'ali.veli@firma.example', kind: 'employee', score: 100 }, scoring);
    expect(general).toBeGreaterThan(manager);
    expect(manager).toBeGreaterThan(employee);
    expect(recipientScore({ email: 'ik@firma.example', kind: 'official_hr', score: 90 }, scoring)).toBeGreaterThan(recipientScore({ email: 'hr@firma.example', kind: 'official_hr', score: 40 }, scoring));
  });
});

describe('adres araştırması şemaları ve yönergeleri', () => {
  it('toplayıcı çıktısı kişi alanlarını ve 25 adresi taşır; denetçi güveni sayıya çevrilir', () => {
    const contacts = Array.from({ length: 25 }, (_, i) => ({ email: `k${i}@firma.example`, roleType: 'employee', origin: 'published', sourceUrl: 'https://firma.example', name: 'Ad', title: 'Unvan', evidence: 'alıntı' }));
    expect(companyContactsOutput.safeParse({ contacts, offices: [] }).success).toBe(true);
    expect(contactReviewOutput.parse({ reviews: [{ ref: 'A1', keep: true, confidence: '80' }] }).reviews[0].confidence).toBe(80);
  });

  it('toplayıcı kişisel adresleri de arar, tahmini işaretler; bilinen ve kaçınılacak adresler bildirilir', () => {
    const prompt = buildPrompt('company_contacts', { company: { name: 'Firma', domain: 'firma.example' }, knownEmails: ['ik@firma.example'], avoidEmails: ['eski@firma.example'] });
    expect(prompt).toContain('Yönetimden kişiler');
    expect(prompt).toContain('origin "pattern"');
    expect(prompt).toContain('ik@firma.example');
    expect(prompt).toContain('eski@firma.example');
    expect(prompt).toContain('CAPTCHA');
    expect(prompt).toContain('origin "likely"');
    expect(prompt).toContain('mailto:');
  });

  it('toplayıcı firmanın sitesini ve kaynaksız olası adresleri bildirebilir', () => {
    const parsed = companyContactsOutput.parse({ website: 'https://firma.example', contacts: [{ email: 'kariyer@firma.example', roleType: 'hr', origin: 'likely', sourceUrl: null }], offices: [] });
    expect(parsed.website).toBe('https://firma.example');
    expect(parsed.contacts[0]).toMatchObject({ origin: 'likely', sourceUrl: null });
  });

  it('denetçi adayları güvenilmeyen veri olarak alır', () => {
    const prompt = buildPrompt('contact_review', { company: { name: 'Firma', domain: 'firma.example' }, candidates: [{ ref: 'A1', email: 'ik@firma.example' }] });
    expect(prompt).toContain('<untrusted_source id="candidates">');
    expect(prompt).toContain('"ref":"A1"');
  });
});

describe('tahmini adresler ve posta sunucusu yoklaması', () => {
  const guess = (email: string, patch: Partial<ReturnType<typeof genericGuess>> = {}) => ({ ...genericGuess(email), ...patch });

  it('yaygın adresler önce İK, sonra genel iletişim sırasıyla denenir', () => {
    expect(roleGuessesFor('firma.example').slice(0, 3)).toEqual(['kariyer@firma.example', 'ik@firma.example', 'hr@firma.example']);
    expect(genericGuess('kariyer@firma.example')).toMatchObject({ kind: 'guessed', roleType: 'hr', score: 20, verified: false });
    expect(genericGuess('info@firma.example')).toMatchObject({ kind: 'guessed', roleType: 'general' });
  });

  it('kutusu doğrulanan tahmin rolünün türüne yükselir ama doğrulanmış sayılmaz; olmayan kutu düşer', () => {
    expect(settleProbedGuess(guess('kariyer@firma.example'), 'exists', false)).toMatchObject({ kind: 'official_hr', score: 55, verified: false });
    expect(settleProbedGuess(guess('info@firma.example'), 'exists', false)).toMatchObject({ kind: 'general' });
    expect(settleProbedGuess(guess('ayse.kaya@firma.example', { roleType: 'recruiting', score: 30 }), 'exists', false)).toMatchObject({ kind: 'named_recruiter', score: 55 });
    expect(settleProbedGuess(guess('ik@firma.example'), 'missing', false)).toBeNull();
    const unknown = settleProbedGuess(guess('ik@firma.example'), 'unknown', true);
    expect(unknown).toMatchObject({ kind: 'guessed', score: 20 });
    expect(unknown?.evidence).toContain('her adresi kabul ediyor');
  });

  it('doğrulanan yaygın adresler tutulur; hiçbiri doğrulanamazsa yalnız kariyer@ ve info@ listelenir', () => {
    const confirmed = settleProbedGuess(guess('ik@firma.example'), 'exists', false)!;
    const unknown = ['kariyer@firma.example', 'hr@firma.example', 'info@firma.example'].map((e) => guess(e));
    expect(pickGenericGuesses([confirmed, ...unknown]).map((c) => c.email)).toEqual(['ik@firma.example']);
    expect(pickGenericGuesses(unknown).map((c) => c.email)).toEqual(['kariyer@firma.example', 'info@firma.example']);
    expect(pickGenericGuesses(unknown, true)).toEqual([]);
  });
});

describe('alan adı bilinmeyen firmada sitenin benimsenmesi', () => {
  it('firma adını taşıyan alan adı benimsenir; alt alan adı kök alan adına indirgenir', () => {
    expect(domainCarriesName('Yıldızlı Gıda İlaç San. Tic. Ltd. Şti.', 'yildizlimarket.com')).toBe(true);
    expect(domainCarriesName('BELDİ', 'kurumsal.beldi.com.tr')).toBe(true);
    expect(domainCarriesName('Rüzgar Gıda San. ve Tic. A.Ş.', 'gidapazari.com')).toBe(false);
    expect(websiteDomainFor('BELDİ', 'https://kurumsal.beldi.com.tr/tr', [])).toBe('beldi.com.tr');
    expect(websiteDomainFor('Martı Koleji Beylikdüzü Kampüs', 'https://www.martikoleji.k12.tr', [])).toBe('martikoleji.k12.tr');
  });

  it('adı taşımayan alan adı, modelin bulduğu kaynaklardan biri o alan adındaysa benimsenir', () => {
    expect(websiteDomainFor('Lucky Luke İletişim', 'https://ll-agency.example', [])).toBeNull();
    expect(websiteDomainFor('Lucky Luke İletişim', 'https://ll-agency.example', ['https://www.ll-agency.example/iletisim'])).toBe('ll-agency.example');
  });

  it('ilan sitesi, sosyal medya ve firma rehberi firma sitesi sayılmaz', () => {
    expect(websiteDomainFor('Tedi', 'https://www.kariyer.net/firma-profil/tedi-43325', ['https://www.kariyer.net/x'])).toBeNull();
    expect(websiteDomainFor('Yıldızlı', 'https://www.linkedin.com/company/yildizli', [])).toBeNull();
    expect(websiteDomainFor('Yıldızlı', 'https://www.firmasec.com/firma/yildizli', [])).toBeNull();
  });
});
