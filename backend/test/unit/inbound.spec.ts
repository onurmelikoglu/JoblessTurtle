import { analyzeBounce, classifyCompanyMail, extractSuggestions, InboundMail, isBounce, messageIdsIn, registrableDomain, stripQuoted } from '../../src/domain/inbound';
import { templateOutput } from '../../src/engine/ai/template-provider';
import { buildIndex } from '../../src/engine/inbox.service';
import { parseMail } from '../../src/engine/mail/inbox';

const mail = (over: Partial<InboundMail>): InboundMail => ({ fromEmail: 'ik@firma.com', fromName: null, subject: '', text: '', headers: {}, contentType: null, ...over });

describe('Geri dönme bildirimi', () => {
  it('Gmail "Address not found" bildirimini hatalı adres olarak sınıflar', () => {
    const m = mail({
      fromEmail: 'mailer-daemon@googlemail.com',
      fromName: 'Mail Delivery Subsystem',
      subject: 'Delivery Status Notification (Failure)',
      text: "Address not found\nYour message wasn't delivered to kariyer@firma.com because the address couldn't be found, or is unable to receive mail.\nThe response from the remote server was:\n550 5.1.1 The email account that you tried to reach does not exist.",
    });
    expect(isBounce(m)).toBe(true);
    expect(analyzeBounce(m).category).toBe('bad_address');
  });

  it('DSN alanlarından durum kodunu ve alıcıyı çıkarır', () => {
    const m = mail({
      fromEmail: 'postmaster@outlook.com',
      subject: 'Undeliverable: Başvuru',
      text: 'Final-Recipient: rfc822; hr@firma.com.tr\nAction: failed\nStatus: 5.7.1\nDiagnostic-Code: smtp; 550 5.7.1 Message rejected due to content policy',
    });
    const info = analyzeBounce(m);
    expect(info.category).toBe('rejected');
    expect(info.status).toBe('5.7.1');
    expect(info.failedRecipient).toBe('hr@firma.com.tr');
    expect(info.diagnostic).toContain('content policy');
  });

  it('gecikme bildirimini başarısızlık saymaz', () => {
    const m = mail({ fromEmail: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Delay)', text: 'Message temporarily deferred. Status: 4.4.1. Gmail will keep trying to deliver it.' });
    expect(analyzeBounce(m).category).toBe('delayed');
  });

  it('dolu kutu, alan adı ve boyut hatalarını ayırır', () => {
    expect(analyzeBounce(mail({ subject: 'Undeliverable', text: 'Status: 5.2.2 mailbox full' })).category).toBe('mailbox_full');
    expect(analyzeBounce(mail({ subject: 'Undeliverable', text: "The domain firma.co couldn't be found" })).category).toBe('bad_domain');
    expect(analyzeBounce(mail({ subject: 'Undeliverable', text: '552 5.3.4 Message size exceeds fixed maximum message size' })).category).toBe('too_large');
  });

  it('firma yanıtını geri dönme bildirimi saymaz', () => {
    expect(isBounce(mail({ subject: 'Re: Başvuru', text: 'Merhaba, CV’nizi aldık.' }))).toBe(false);
  });
});

describe('Firma yanıtı', () => {
  it('otomatik yanıt ve ofis dışı yanıtını ayırır', () => {
    expect(classifyCompanyMail(mail({ subject: 'Otomatik yanıt: Başvuru', text: 'Mailiniz bize ulaşmıştır.', headers: { 'auto-submitted': 'auto-replied' } }))).toBe('auto_reply');
    expect(classifyCompanyMail(mail({ subject: 'Automatic reply: Başvuru', text: 'I am out of office until Monday.' }))).toBe('out_of_office');
  });

  it('kariyer sitesine yönlendirmeyi ve adres değişikliğini tanır', () => {
    expect(classifyCompanyMail(mail({ subject: 'Otomatik yanıt', text: 'E-posta ile gelen başvurular kabul edilmemektedir. Başvurularınızı kariyer sitemiz üzerinden yapabilirsiniz.', headers: { 'auto-submitted': 'auto-replied' } }))).toBe('apply_elsewhere');
    expect(classifyCompanyMail(mail({ subject: 'Bilgilendirme', text: 'Bu adres artık kullanılmamaktadır. Lütfen insankaynaklari@firma.com adresine yazınız.' }))).toBe('address_changed');
  });

  it('biçim kuralına uymayan maili tanır', () => {
    expect(classifyCompanyMail(mail({ subject: 'Otomatik yanıt', text: 'Başvurunuz işleme alınamadı. Konu satırına ilan kodunu yazmanız gerekmektedir.', headers: { 'auto-submitted': 'auto-replied' } }))).toBe('format_issue');
  });

  it('ret ve görüşme davetini tanır', () => {
    expect(classifyCompanyMail(mail({ subject: 'Re: Başvuru', text: 'Maalesef şu an için uygun bir pozisyonumuz bulunmamaktadır.' }))).toBe('rejection');
    expect(classifyCompanyMail(mail({ subject: 'Re: Başvuru', text: 'Sizinle bir görüşme ayarlamak isteriz, uygun olduğunuz gün nedir?' }))).toBe('interview');
  });

  it('öneri adresini ve kariyer bağlantısını çıkarır', () => {
    const s = extractSuggestions('Lütfen ik@firma.com adresine yazın veya https://kariyer.firma.com/ilanlar adresinden başvurun.', ['info@firma.com']);
    expect(s.email).toBe('ik@firma.com');
    expect(s.url).toBe('https://kariyer.firma.com/ilanlar');
  });

  it('alıntılanmış önceki mesajı ayırır', () => {
    expect(stripQuoted('Teşekkürler, inceleyeceğiz.\n\nOn Mon, 6 Oct 2026 at 10:00, Aday <a@b.com> wrote:\n> Merhaba')).toBe('Teşekkürler, inceleyeceğiz.');
  });
});

describe('Başvuru eşleştirme', () => {
  const sentAt = new Date('2026-10-06T10:00:00Z');
  const attempts = [
    { id: 'a1', workspaceId: 'w', companyId: 'c1', toEmail: 'kariyer@firma.com.tr', providerMessageId: '<abc-123@gmail.com>', acceptedAt: sentAt, createdAt: sentAt, state: 'provider_accepted' },
    { id: 'a2', workspaceId: 'w', companyId: 'c2', toEmail: 'firmaik@gmail.com', providerMessageId: '<def-456@gmail.com>', acceptedAt: sentAt, createdAt: sentAt, state: 'provider_accepted' },
  ];
  const index = buildIndex({ accountEmail: 'aday@gmail.com' }, attempts);
  const env = (over: object) => ({ uid: 1, messageId: '<x@y>', inReplyTo: null, date: new Date('2026-10-07T10:00:00Z'), fromEmail: 'x@z.com', fromName: null, subject: 'Merhaba', ...over });

  it('ilgili mailleri seçer, alakasızları atlar', () => {
    expect(index.relevant(env({ fromEmail: 'ik@ik.firma.com.tr' }))).toBe(true);
    expect(index.relevant(env({ fromEmail: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)' }))).toBe(true);
    expect(index.relevant(env({ fromEmail: 'kampanya@baskafirma.com' }))).toBe(false);
    expect(index.relevant(env({ fromEmail: 'baska@gmail.com' }))).toBe(false);
    expect(index.relevant(env({ fromEmail: 'aday@gmail.com' }))).toBe(false);
  });

  it('geri dönme bildirimini orijinal Message-ID ile eşleştirir', async () => {
    const raw = Buffer.from(
      'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>\r\nSubject: Delivery Status Notification (Failure)\r\nMessage-ID: <bounce-1@google.com>\r\nContent-Type: text/plain\r\n\r\nAddress not found 550 5.1.1\r\n\r\nMessage-ID: <ABC-123@gmail.com>\r\n',
    );
    const m = await parseMail(raw, { messageId: '<bounce-1@google.com>', date: new Date('2026-10-06T10:01:00Z'), fromEmail: 'mailer-daemon@googlemail.com', fromName: 'Mail Delivery Subsystem', subject: 'Delivery Status Notification (Failure)' });
    expect(index.match(m)?.id).toBe('a1');
  });

  it('firma yanıtını alan adından, bülteni ise atlar', async () => {
    const reply = await parseMail(Buffer.from('From: ik@firma.com.tr\r\nSubject: Re: Başvuru\r\n\r\nTeşekkürler'), { messageId: '<r1@firma>', date: new Date('2026-10-07T10:00:00Z'), fromEmail: 'ik@firma.com.tr', fromName: null, subject: 'Re: Başvuru' });
    expect(index.match(reply)?.id).toBe('a1');
    const bulletin = await parseMail(Buffer.from('From: haber@firma.com.tr\r\nList-Unsubscribe: <https://firma.com.tr/u>\r\nSubject: Bülten\r\n\r\nYeni ürünler'), { messageId: '<b1@firma>', date: new Date('2026-10-07T10:00:00Z'), fromEmail: 'haber@firma.com.tr', fromName: null, subject: 'Bülten' });
    expect(index.match(bulletin)).toBeNull();
  });

  it('gönderimden önceki maili eşleştirmez', async () => {
    const early = await parseMail(Buffer.from('From: ik@firma.com.tr\r\nSubject: Duyuru\r\n\r\nMerhaba'), { messageId: '<e1@firma>', date: new Date('2026-10-01T10:00:00Z'), fromEmail: 'ik@firma.com.tr', fromName: null, subject: 'Duyuru' });
    expect(index.match(early)).toBeNull();
  });

  it('kayıtlı alan adını ve Message-ID listesini çıkarır', () => {
    expect(registrableDomain('ik@kariyer.firma.com.tr')).toBe('firma.com.tr');
    expect(registrableDomain('hr@jobs.firma.com')).toBe('firma.com');
    expect(messageIdsIn('Message-ID: <AB12-cd@b.com>\nIn-Reply-To: <c-1234@gmail.com>')).toEqual(['<ab12-cd@b.com>', '<c-1234@gmail.com>']);
  });
});

describe('Durum kodu önceliği', () => {
  it('Exchange bildiriminde Google 5.1.1 kodunu hatalı adres sayar', () => {
    const m = mail({ fromEmail: 'postmaster@pazaryeri.com', subject: 'Undeliverable: Başvuru', text: "The email address you entered couldn't be found.\nRemote Server returned '550-5.1.1 The email account that you tried to reach does not exist.'" });
    expect(analyzeBounce(m).category).toBe('bad_address');
  });

  it('yalnızca iç göndericiye açık grubu ayrı sınıflar', () => {
    const m = mail({ fromEmail: 'postmaster@firma.onmicrosoft.com', subject: 'Undeliverable: Başvuru', text: 'Remote Server returned 550 5.7.133 RESOLVER.RST.SenderNotAuthenticatedForGroup; authentication required' });
    expect(analyzeBounce(m).category).toBe('closed_address');
  });

  it('anket ve destek talebi bildirimlerini yanıt saymaz', () => {
    expect(classifyCompanyMail(mail({ fromEmail: 'destek@firma.com', subject: 'Destek Ekibimizi Değerlendirir misiniz?', text: 'Lütfen ankete katılın.' }))).toBe('auto_reply');
  });
});

describe('Karşı sunucu yanıtı önceliği', () => {
  it('Gmail 5.7.0 durumunda karşı sunucunun 5.1.1 yanıtını esas alır', () => {
    const m = mail({
      fromEmail: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Failure)',
      text: 'Final-Recipient: rfc822; iletisim@firma.com\nAction: failed\nStatus: 5.7.0\nDiagnostic-Code: smtp; 550 Invalid recipient <iletisim@firma.com> (#5.1.1)',
    });
    expect(analyzeBounce(m).category).toBe('bad_address');
  });

  it('kurum politikası reddini korur', () => {
    const m = mail({ fromEmail: 'postmaster@firma.com', subject: 'Undeliverable: Başvuru', text: 'Remote Server returned 550 5.7.1 TRANSPORT.RULES.RejectMessage; the message was rejected by organization policy' });
    expect(analyzeBounce(m).category).toBe('rejected');
  });
});

describe('Otomatik düzeltme yedek kararı', () => {
  const plan = (input: object) => templateOutput('inbound_fix', { sentTo: 'eski@firma.com', candidates: [], ...input }) as { action: string; toEmail?: string; attachments?: string };

  it('kariyer sitesi isteyeni atlar, önerilen adrese yönlendirir', () => {
    expect(plan({ category: 'apply_elsewhere' }).action).toBe('skip');
    expect(plan({ category: 'address_changed', suggestedEmail: 'careers@firma.com' })).toMatchObject({ action: 'resend', toEmail: 'careers@firma.com' });
  });

  it('geçersiz adreste diğer adresi kullanır, yoksa araştırma ister', () => {
    expect(plan({ category: 'bad_address', candidates: [{ email: 'ik@firma.com' }] })).toMatchObject({ action: 'resend', toEmail: 'ik@firma.com' });
    expect(plan({ category: 'bad_address' }).action).toBe('research');
  });

  it('boyut sorununda aynı adrese yalnızca CV ile gönderir', () => {
    expect(plan({ category: 'too_large' })).toMatchObject({ action: 'resend', toEmail: 'eski@firma.com', attachments: 'cv_only' });
  });
});
