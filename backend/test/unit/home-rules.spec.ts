import { activityItems, activityOfAiKind, activityOfOutboxEvent, activityOfQueueJob, activityStatus, mergeActivity } from '../../src/domain/activity';
import { companyLinks, jobApplyLinks, mergeLinks, replyApplyLink, safeLinkUrl } from '../../src/domain/apply-links';
import { classOfCompany, classOfOpportunity } from '../../src/domain/company-class';

describe('firma sınıfı', () => {
  const opp = (category: string, jobId: string | null = null) => ({ category, jobId });

  it('hedef, yakın ve kullanıcının seçtiği ilan açık ilan sınıfıdır', () => {
    for (const category of ['target_open', 'adjacent_open', 'user_selected']) expect(classOfOpportunity(opp(category, 'j1'))).toBe('open');
  });

  it('teyit gereken kayıt ilana bağlıysa açık ilan, firmaya bağlıysa potansiyeldir', () => {
    expect(classOfOpportunity(opp('needs_confirmation', 'j1'))).toBe('open');
    expect(classOfOpportunity(opp('needs_confirmation'))).toBe('potential');
  });

  it('kapanmış ilgili ilan geçmiş, ilanı görülmemiş firma potansiyeldir', () => {
    expect(classOfOpportunity(opp('past_closed', 'j1'))).toBe('past');
    expect(classOfOpportunity(opp('sector_target'))).toBe('potential');
    expect(classOfOpportunity(opp('not_found'))).toBe('potential');
  });

  it('hariç tutulan kategori sınıf üretmez', () => {
    expect(classOfOpportunity(opp('excluded', 'j1'))).toBeNull();
  });

  it('firma en güçlü sınıfı alır; görünür fırsatı yoksa sınıfı yoktur', () => {
    expect(classOfCompany([opp('past_closed', 'j1'), opp('adjacent_open', 'j2')])).toBe('open');
    expect(classOfCompany([opp('past_closed', 'j1'), opp('excluded', 'j2')])).toBe('past');
    expect(classOfCompany([opp('excluded', 'j1')])).toBeNull();
    expect(classOfCompany([])).toBeNull();
  });
});

describe('başvuru bağlantıları', () => {
  it('yalnızca http(s) bağlantısı kabul eder, şemasız adresi https sayar', () => {
    expect(safeLinkUrl('kariyer.firma.com/basvuru')).toBe('https://kariyer.firma.com/basvuru');
    expect(safeLinkUrl('http://firma.com')).toBe('http://firma.com/');
    expect(safeLinkUrl('javascript:alert(1)')).toBeNull();
    expect(safeLinkUrl('data:text/html,<script>')).toBeNull();
    expect(safeLinkUrl('mailto:ik@firma.com')).toBeNull();
    expect(safeLinkUrl('localhost')).toBeNull();
    expect(safeLinkUrl('  ')).toBeNull();
    expect(safeLinkUrl(null)).toBeNull();
  });

  it('platform ilanlarını adıyla, firma formunu genel etiketle verir', () => {
    const links = jobApplyLinks({
      applyUrl: 'https://boards.greenhouse.io/firma/jobs/1',
      channel: 'ats_form',
      listings: [
        { applyUrl: null, canonicalUrl: 'https://www.linkedin.com/jobs/view/123' },
        { applyUrl: 'https://www.kariyer.net/is-ilani/firma-ios-123', canonicalUrl: null },
        { applyUrl: null, canonicalUrl: 'https://tr.indeed.com/viewjob?jk=1' },
      ],
    });
    expect(links.map((l) => l.kind)).toEqual(['form', 'linkedin', 'kariyernet', 'indeed']);
    expect(links[0].label).toBe('Başvuru formunu aç');
    expect(links[1].label).toBe("LinkedIn'de başvur");
  });

  it('aynı sitedeki ilan ve başvuru sayfası tek kanaldır; geçersiz bağlantı atılır', () => {
    const links = jobApplyLinks({
      applyUrl: 'https://jobs.lever.co/firma/abc/apply',
      channel: 'ats_form',
      listings: [
        { applyUrl: 'https://jobs.lever.co/firma/abc/apply', canonicalUrl: 'https://jobs.lever.co/firma/abc' },
        { applyUrl: 'javascript:void(0)', canonicalUrl: 'https://FIRMA.com/kariyer/ios#basvur' },
      ],
    });
    expect(links).toEqual([
      { kind: 'form', label: 'Başvuru formunu aç', url: 'https://jobs.lever.co/firma/abc/apply' },
      { kind: 'form', label: 'Başvuru formunu aç', url: 'https://firma.com/kariyer/ios#basvur' },
    ]);
  });

  it('firma bağlantıları: kariyer sayfası ve site; aynıysa tek bağlantı', () => {
    expect(companyLinks({ careersUrl: 'https://firma.com/kariyer', website: 'https://firma.com' }).map((l) => l.kind)).toEqual(['careers', 'website']);
    expect(companyLinks({ careersUrl: 'https://firma.com', website: 'https://firma.com/' })).toHaveLength(1);
    expect(companyLinks({ careersUrl: null, website: null })).toEqual([]);
  });

  it('firmanın yanıtında verdiği bağlantı öne alınır ve tekrar etmez', () => {
    const reply = replyApplyLink('firma.com/kariyer');
    expect(reply).toEqual({ kind: 'reply', label: 'Firmanın istediği başvuru sayfası', url: 'https://firma.com/kariyer' });
    const merged = mergeLinks([reply, replyApplyLink(null)], companyLinks({ careersUrl: 'https://firma.com/kariyer', website: 'https://firma.com' }));
    expect(merged.map((l) => l.kind)).toEqual(['reply', 'website']);
  });
});

describe('etkinlik durumu', () => {
  it('AI görevlerini, kuyruk işlerini ve olayları etkinlik türüne eşler', () => {
    expect(activityOfAiKind('company_contacts')).toBe('contacts');
    expect(activityOfAiKind('letter_company_line')).toBe('letters');
    expect(activityOfAiKind('bilinmeyen')).toBeNull();
    expect(activityOfQueueJob('research', 'company')).toBe('research');
    expect(activityOfQueueJob('interactive', 'company_lookup')).toBe('discovery');
    expect(activityOfQueueJob('evaluate', 'profile')).toBeNull();
    expect(activityOfOutboxEvent('research.details.bulk')).toBe('contacts');
    expect(activityOfOutboxEvent('notify')).toBeNull();
  });

  it('zamanlanmış kaynak taraması rutindir, kullanıcının başlattığı tarama değildir', () => {
    expect(activityOfQueueJob('collect', 'source', { trigger: 'schedule' })).toBe('routine');
    expect(activityOfQueueJob('collect', 'source', {})).toBe('routine');
    expect(activityOfQueueJob('collect', 'source', { trigger: 'manual' })).toBe('crawl');
  });

  it('çalışan sayısında büyük olanı alır, bekleyenleri toplar', () => {
    const merged = mergeActivity({ research: { running: 2, queued: 5 } }, { research: { running: 1, queued: 3 }, contacts: { running: 1, queued: 0 } });
    expect(merged).toEqual({ research: { running: 2, queued: 8 }, contacts: { running: 1, queued: 0 } });
    expect(activityItems(merged)).toEqual([
      { kind: 'research', label: 'Firma analizi', running: 2, queued: 8 },
      { kind: 'contacts', label: 'Mail adresi araması', running: 1, queued: 0 },
    ]);
  });

  it('iş yokken ve yalnızca rutin tarama, gönderim veya gelen kutusu çalışırken durum beklemededir', () => {
    const base = { paused: false, backlogLetters: 0, aiBlocked: false };
    expect(activityStatus({ ...base, counts: {} })).toBe('idle');
    expect(activityStatus({ ...base, counts: { routine: { running: 3, queued: 10 } } })).toBe('idle');
    expect(activityStatus({ ...base, counts: { send: { running: 1, queued: 0 }, inbox: { running: 1, queued: 0 } } })).toBe('idle');
  });

  it('birikmiş yazı tek başına "çalışıyor" yapmaz; AI hakkı yoksa beklendiği söylenir', () => {
    expect(activityStatus({ paused: false, counts: {}, backlogLetters: 40, aiBlocked: false })).toBe('idle');
    expect(activityStatus({ paused: false, counts: {}, backlogLetters: 40, aiBlocked: true })).toBe('waiting_ai');
    expect(activityStatus({ paused: false, counts: {}, backlogLetters: 0, aiBlocked: true })).toBe('idle');
  });

  it('gerçek iş varken çalışıyor, durdurulmuşken her koşulda durduruldu', () => {
    const counts = { letters: { running: 0, queued: 2 } };
    expect(activityStatus({ paused: false, counts, backlogLetters: 0, aiBlocked: true })).toBe('working');
    expect(activityStatus({ paused: true, counts, backlogLetters: 5, aiBlocked: false })).toBe('paused');
  });
});
