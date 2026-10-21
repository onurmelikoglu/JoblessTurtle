import * as net from 'net';
import { classifyRcptReply, probeMailboxes, takeReply } from '../../src/engine/mail/smtp-probe';

type Mailserver = { port: number; close: () => Promise<void>; commands: string[] };

/** Yerel sahte posta sunucusu: yalnızca listedeki kutuları kabul eder; catchAll ise her adresi kabul eder. */
function mailserver(opts: { mailboxes: string[]; catchAll?: boolean; rejectWith?: string }): Promise<Mailserver> {
  const commands: string[] = [];
  const server = net.createServer((socket) => {
    socket.write('220 mx.firma.example ESMTP\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let at: number;
      while ((at = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        commands.push(line);
        if (/^EHLO/i.test(line)) socket.write('250-mx.firma.example\r\n250-SIZE 1000\r\n250 OK\r\n');
        else if (/^MAIL FROM/i.test(line)) socket.write('250 2.1.0 OK\r\n');
        else if (/^RCPT TO/i.test(line)) {
          const email = /<([^>]+)>/.exec(line)?.[1] ?? '';
          if (opts.rejectWith) socket.write(`${opts.rejectWith}\r\n`);
          else if (opts.catchAll || opts.mailboxes.includes(email)) socket.write('250 2.1.5 OK\r\n');
          else socket.write('550-5.1.1 The email account that you tried to reach does not exist.\r\n550 5.1.1 Please try double-checking the recipient\r\n');
        } else if (/^QUIT/i.test(line)) socket.end('221 2.0.0 Bye\r\n');
        else socket.write('502 5.5.1 Unrecognized command\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, commands, close: () => new Promise((done) => server.close(() => done())) })),
  );
}

const localMx = async () => [{ exchange: '127.0.0.1', priority: 10 }];

describe('posta sunucusu cevabının yorumu', () => {
  it('çok satırlı cevap son satırıyla birlikte ayrılır', () => {
    expect(takeReply('250-mx\r\n250-SIZE\r\n250 OK\r\n220 sonraki')).toEqual({ reply: { code: 250, text: '250-mx\n250-SIZE\n250 OK' }, rest: '220 sonraki' });
    expect(takeReply('250-mx\r\n250-SIZE')).toBeNull();
  });

  it('yalnız kutunun olmadığını açıkça söyleyen ret "yok" sayılır; engel ve gecikme "bilinmiyor" kalır', () => {
    expect(classifyRcptReply({ code: 250, text: '250 2.1.5 OK' })).toBe('exists');
    expect(classifyRcptReply({ code: 550, text: '550 5.1.1 User unknown' })).toBe('missing');
    expect(classifyRcptReply({ code: 550, text: '550 5.7.1 Service unavailable; client host blocked using Spamhaus' })).toBe('unknown');
    expect(classifyRcptReply({ code: 451, text: '451 4.7.1 Greylisted, try again later' })).toBe('unknown');
    expect(classifyRcptReply(null)).toBe('unknown');
  });
});

describe('posta kutusu yoklaması', () => {
  it('olmayan adresi reddeden sunucuda kutular ayrışır; mail gönderilmez', async () => {
    const mx = await mailserver({ mailboxes: ['kariyer@firma.example'] });
    const probe = await probeMailboxes('firma.example', ['kariyer@firma.example', 'ik@firma.example'], { resolveMx: localMx, port: mx.port, timeoutMs: 3000, helo: 'test.example' });
    await mx.close();
    expect(probe).toMatchObject({ mx: true, catchAll: false });
    expect(Object.fromEntries(probe.verdicts)).toEqual({ 'kariyer@firma.example': 'exists', 'ik@firma.example': 'missing' });
    expect(mx.commands[0]).toBe('EHLO test.example');
    expect(mx.commands.some((c) => /^DATA/i.test(c))).toBe(false);
  });

  it('her adresi kabul eden alan adında "var" cevabı kanıt sayılmaz', async () => {
    const mx = await mailserver({ mailboxes: [], catchAll: true });
    const probe = await probeMailboxes('firma.example', ['kariyer@firma.example'], { resolveMx: localMx, port: mx.port, timeoutMs: 3000 });
    await mx.close();
    expect(probe).toMatchObject({ mx: true, catchAll: true });
    expect(probe.verdicts.get('kariyer@firma.example')).toBe('unknown');
  });

  it('engel cevabında ve ulaşılamayan sunucuda hiçbir adres elenmez; MX yoksa yoklama yapılmaz', async () => {
    const mx = await mailserver({ mailboxes: [], rejectWith: '554 5.7.1 Client host rejected: listed at a blocklist' });
    const blocked = await probeMailboxes('firma.example', ['kariyer@firma.example'], { resolveMx: localMx, port: mx.port, timeoutMs: 3000 });
    await mx.close();
    expect(blocked.verdicts.get('kariyer@firma.example')).toBe('unknown');
    const unreachable = await probeMailboxes('firma.example', ['kariyer@firma.example'], { resolveMx: localMx, port: mx.port, timeoutMs: 1000 });
    expect(unreachable).toMatchObject({ mx: true, catchAll: null });
    expect(unreachable.verdicts.get('kariyer@firma.example')).toBe('unknown');
    const noMx = await probeMailboxes('firma.example', ['kariyer@firma.example'], { resolveMx: async () => [] });
    expect(noMx.mx).toBe(false);
  });
});
