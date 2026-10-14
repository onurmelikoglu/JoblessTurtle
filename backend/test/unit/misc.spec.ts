import { classifyPublishedEmail, domainMatches, extractEmails, isValidEmail, recipientScore } from '../../src/domain/contacts';
import { deflateSync } from 'zlib';
import { scanFile } from '../../src/domain/file-scan';
import { redactPersonalInfo } from '../../src/engine/letter.service';
import { escapeCell, toCsv } from '../../src/domain/csv';
import { assertSafeUrl, isPrivateAddress, safeFetch } from '../../src/domain/ssrf';
import { checkDraftContent, DEFAULT_TEMPLATES, renderTemplate, unknownVariables } from '../../src/domain/templates';
import { isTurkishUrl, normalizeDomain, preferTurkishUrl, replaceAdWord } from '../../src/domain/text';

describe('SSRF koruması', () => {
  it('özel ağ, loopback ve metadata adreslerini engeller', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1'])
      expect(isPrivateAddress(ip)).toBe(true);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
  });

  it('URL doğrulama', () => {
    expect(() => assertSafeUrl('http://localhost:3000')).toThrow();
    expect(() => assertSafeUrl('http://169.254.169.254/latest/meta-data')).toThrow();
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow();
    expect(() => assertSafeUrl('https://user:pw@example.com')).toThrow();
    expect(assertSafeUrl('https://boards.greenhouse.io/x').hostname).toBe('boards.greenhouse.io');
  });

  it('private IP\'ye çözümlenen alan adına bağlanmaz', async () => {
    await expect(safeFetch('http://localtest.me:9/')).rejects.toThrow();
    await expect(safeFetch('http://127.0.0.1:9/')).rejects.toThrow(/engellendi/);
  });
});

describe('CSV formül kaçışı', () => {
  it('formül başlangıçlarını kaçırır', () => {
    expect(escapeCell('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(escapeCell('+90 555')).toBe(`'+90 555`);
    expect(escapeCell('@cmd')).toBe(`'@cmd`);
    expect(escapeCell('normal')).toBe('normal');
    expect(toCsv(['a'], [['=1+1']])).toContain(`'=1+1`);
  });
});

describe('iletişim sınıflama', () => {
  it('İK, genel ve satış adresleri ayrılır', () => {
    expect(classifyPublishedEmail('ik@ajans.com').kind).toBe('official_hr');
    expect(classifyPublishedEmail('careers@ajans.com').kind).toBe('official_hr');
    expect(classifyPublishedEmail('info@ajans.com').kind).toBe('general');
    expect(classifyPublishedEmail('newbusiness@ajans.com').kind).toBe('non_hr');
    expect(classifyPublishedEmail('destek@odemefirma.com.tr').kind).toBe('non_hr');
    expect(classifyPublishedEmail('kvkk_bilgi@ajans.com').kind).toBe('non_hr');
    expect(classifyPublishedEmail('oncemusteri@banka.com').kind).toBe('non_hr');
    expect(classifyPublishedEmail('isealim@ajans.com').kind).toBe('official_hr');
    expect(classifyPublishedEmail('telekomfirma@telekomfirma.com.tr').kind).toBe('general');
    expect(classifyPublishedEmail('ayse.ornek@ajans.com').kind).toBe('other');
    expect(classifyPublishedEmail('phishing-bildir@kargofirma.com').kind).toBe('non_hr');
    expect(classifyPublishedEmail('recruiters@fintechfirma.com').kind).toBe('official_hr');
    expect(classifyPublishedEmail('mehmet@ajans.com').kind).toBe('other');
  });
  it('bozuk ve örnek adresler ayıklanır', () => {
    expect(isValidEmail('//info@ajans.com')).toBe(false);
    expect(isValidEmail('name.surname@ajans.com')).toBe(false);
    expect(isValidEmail('ornek@ajans.com')).toBe(false);
    expect(extractEmails('mailto:%20inovasyon@ajans.com u003elegal@ajans.com')).toEqual(['inovasyon@ajans.com', 'legal@ajans.com']);
  });
  it('alan adı eşleşmesi', () => {
    expect(domainMatches('ik@ajans.com.tr', 'www.ajans.com.tr')).toBe(true);
    expect(domainMatches('ik@baska.com', 'ajans.com.tr')).toBe(false);
    expect(normalizeDomain('https://www.Ajans.com/tr/')).toBe('ajans.com');
  });
  it('sayfadan adres çıkarır, görsel adlarını almaz', () => {
    expect(extractEmails('Bize ulaşın: <a href="mailto:ik@ajans.com">ik</a> logo@2x.png')).toEqual(['ik@ajans.com']);
  });
});

describe('şablon kuralları', () => {
  it('yalnızca allowlist değişkenleri doldurulur', () => {
    expect(renderTemplate('Merhaba {company} {secret}', { company: 'X' })).toBe('Merhaba X');
    expect(unknownVariables('{company} {recipient_email}')).toEqual(['recipient_email']);
  });

  it('ilanı olmayan firmaya ilan ifadesi üretilemez', () => {
    const r = checkDraftContent({
      intent: 'general_intent',
      subject: 'Tanışma',
      body: 'Merhaba, ilanınıza başvuruyorum ve ekibinize katılmak istiyorum.',
      verifiedFactsText: '',
      allowedEmails: [],
    });
    expect(r.ok).toBe(false);
  });

  it('varsayılan genel niyet şablonu kurallara uyar', () => {
    const t = DEFAULT_TEMPLATES.general_intent;
    const body = renderTemplate(t.body, { company: 'Ajans', headline: 'Kreatif direktörüm.', signature: 'Ad' });
    expect(checkDraftContent({ intent: 'general_intent', subject: 'x', body, verifiedFactsText: '', allowedEmails: [] }).ok).toBe(true);
  });

  it('adayda olmayan yıl iddiası ve yabancı e-posta reddedilir', () => {
    const r = checkDraftContent({
      intent: 'job_application',
      subject: 'Başvuru',
      body: '15 yıl deneyimim var. Bana baska@kisi.com adresinden yazın.',
      verifiedFactsText: '12 yıl ajans deneyimi',
      allowedEmails: ['aday@mail.com'],
    });
    expect(r.problems.length).toBe(2);
  });
});

describe('örnek yazıda kişisel bilgi maskeleme', () => {
  it('ad, e-posta, telefon ve bağlantıları gizler', () => {
    const text = 'Merhaba, ben Ayşe Yılmaz.\nAyşe Yılmaz\n0555 000 00 00\nayse@example.com\nlinkedin.com/in/ayse';
    const out = redactPersonalInfo(text, ['Ayşe Yılmaz']);
    expect(out).not.toMatch(/Ayşe|Yılmaz|0555|ayse@|linkedin/i);
    expect(out).toContain('[Ad] [Ad]');
    expect(out).toContain('[telefon]');
  });
});

describe('PDF etkin içerik taraması', () => {
  const pdf = (body: string | Buffer) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\n%%EOF')]);
  it('içerik akışındaki rastgele /JS baytlarını yanlış alarm saymaz', () => {
    expect(scanFile('cv.pdf', pdf('1 0 obj\n<< /Length 20 /Filter /FlateDecode >>\nstream\nxx/JS yy/Launch zz\nendstream\nendobj\n'), 1e7).ok).toBe(true);
  });
  it('nesne sözlüğündeki JavaScript eylemini reddeder', () => {
    const r = scanFile('cv.pdf', pdf('1 0 obj\n<< /Type /Action /S /JavaScript /JS (app.alert(1)) >>\nendobj\n'), 1e7);
    expect(r.ok).toBe(false);
  });
  it('sıkıştırılmış nesne akışındaki JavaScript eylemini reddeder', () => {
    const hidden = deflateSync(Buffer.from('<< /S /JavaScript /JS (x) >>'));
    const r = scanFile('cv.pdf', pdf(Buffer.concat([Buffer.from(`2 0 obj\n<< /Type /ObjStm /Filter /FlateDecode /Length ${hidden.length} >>\nstream\n`), hidden, Buffer.from('\nendstream\nendobj\n')])), 1e7);
    expect(r.ok).toBe(false);
  });
  it('C2PA içerik kimliği kaydına izin verir, diğer gömülü dosyaları reddeder', () => {
    const c2pa = pdf('1257 0 obj\n<</Type/EmbeddedFile/Subtype/application#2Fc2pa/Length 4>>stream\njumb\nendstream\nendobj\n');
    expect(scanFile('portfolio.pdf', c2pa, 1e7).ok).toBe(true);
    const exe = pdf('9 0 obj\n<</Type/EmbeddedFile/Subtype/application#2Foctet-stream/Length 4>>stream\nMZxx\nendstream\nendobj\n');
    expect(scanFile('portfolio.pdf', exe, 1e7).ok).toBe(false);
  });
});

describe('KEP adresleri', () => {
  it('KEP adresini başvuru alıcısı saymaz', () => {
    expect(classifyPublishedEmail('magaza@magazafirma.hs03.kep.tr').kind).toBe('non_hr');
    expect(classifyPublishedEmail('ik@firma.com.tr').kind).toBe('official_hr');
  });
});

describe('varsayılan alıcı seçimi', () => {
  const c = (email: string, kind: string, verifiedAt: Date | null = null) => ({ email, kind, verifiedAt });
  it('İK adresi doğrulanmış genel adresin önüne geçer', () => {
    expect(recipientScore(c('ik@firma.com', 'official_hr'), { domain: 'firma.com' })).toBeGreaterThan(recipientScore(c('info@firma.com', 'general', new Date()), { domain: 'firma.com', preferVerified: true }));
  });
  it('aynı türde firma alan adındaki ve İK\'ya özgü adres öne çıkar', () => {
    expect(recipientScore(c('ik@firma.com', 'official_hr'), { domain: 'firma.com' })).toBeGreaterThan(recipientScore(c('ik@grup.com', 'official_hr'), { domain: 'firma.com' }));
    expect(recipientScore(c('kariyer@firma.com', 'official_hr'), { domain: 'firma.com' })).toBeGreaterThan(recipientScore(c('people@firma.com', 'official_hr'), { domain: 'firma.com' }));
  });
  it('şablon alan adları geçersiz sayılır', () => {
    expect(isValidEmail('info@email.com')).toBe(false);
    expect(isValidEmail('hr@company.com')).toBe(false);
  });
});

describe('Türkiye kariyer sayfası tercihi', () => {
  it('Türkiye bağlantılarını tanır ve öne alır', () => {
    expect(isTurkishUrl('https://www.dhlecommerce.com.tr/ise-alim-ve-kariyer')).toBe(true);
    expect(isTurkishUrl('https://careers.dhl.com/tr/tr/jobs')).toBe(true);
    expect(isTurkishUrl('https://careers.dhl.com/global/en/jobs-in-atlanta')).toBe(false);
    expect(preferTurkishUrl(['https://careers.dhl.com/global/en/jobs-in-atlanta', 'https://www.dhlecommerce.com.tr/kariyer'])).toBe('https://www.dhlecommerce.com.tr/kariyer');
    expect(preferTurkishUrl([null, 'https://jobs.lever.co/firma'])).toBe('https://jobs.lever.co/firma');
  });
});

describe('"ilan" kelimesinin değiştirilmesi', () => {
  it('çekimleri ünlü uyumuyla pozisyona çevirir', () => {
    expect(replaceAdWord('şu an açık bir ilan görmesem de')).toBe('şu an açık bir pozisyon görmesem de');
    expect(replaceAdWord('açık bir ilanınız görünmüyor')).toBe('açık bir pozisyonunuz görünmüyor');
    expect(replaceAdWord('ilanınıza başvuruyorum')).toBe('pozisyonunuza başvuruyorum');
    expect(replaceAdWord('İlanı gördüm, ilanlarınız ve ilanındaki şartlar')).toBe('Pozisyonu gördüm, pozisyonlarınız ve pozisyonundaki şartlar');
  });
  it('başka kelimelerin içindeki "ilan" ve zaten doğru metinler değişmez', () => {
    expect(replaceAdWord('Dilan, Milano ve Atilan ile görüştüm')).toBe('Dilan, Milano ve Atilan ile görüştüm');
    expect(replaceAdWord('Flutter pozisyonu ilanına başvuruyorum')).toBe('Flutter pozisyonuna başvuruyorum');
    expect(replaceAdWord('Mobil pozisyonuna başvuruyorum')).toBe('Mobil pozisyonuna başvuruyorum');
  });
});
