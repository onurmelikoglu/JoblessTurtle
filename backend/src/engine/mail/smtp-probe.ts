import { randomBytes } from 'crypto';
import { promises as dns } from 'dns';
import * as net from 'net';

/**
 * Posta kutusu yoklaması: alan adının MX sunucusuna bağlanıp RCPT TO ile "bu kutu var mı" diye sorulur; DATA
 * gönderilmez, yani mail iletilmez. Aynı oturumda rastgele bir adres de sorulur: sunucu onu da kabul ediyorsa alan adı
 * her adresi kabul ediyordur (catch-all) ve "var" cevabı bir şey kanıtlamaz. Bağlantı, engel listesi, gecikmeli
 * (greylisting) ya da politika cevaplarında sonuç "bilinmiyor" sayılır; yoklama hiçbir adresi kendiliğinden elemez.
 */
export type MailboxVerdict = 'exists' | 'missing' | 'unknown';

export interface MailboxProbe {
  /** Alan adı mail alıyor mu (MX kaydı var mı). false ise yoklama yapılmaz, bütün adresler bilinmiyor kalır. */
  mx: boolean;
  /** true: sunucu her adresi kabul ediyor · false: olmayan kutuyu reddediyor · null: anlaşılamadı. */
  catchAll: boolean | null;
  verdicts: Map<string, MailboxVerdict>;
}

export interface SmtpReply {
  code: number;
  text: string;
}

type MxRecord = { exchange: string; priority: number };

export interface ProbeOptions {
  resolveMx?: (domain: string) => Promise<MxRecord[]>;
  port?: number;
  /** Tek bir sunucuyla konuşmanın toplam süresi. */
  timeoutMs?: number;
  helo?: string;
}

const SMTP_PORT = 25;
const SESSION_TIMEOUT_MS = 12_000;
const MAX_MX_HOSTS = 2;
const MAX_RECIPIENTS = 8;
const MISSING_MAILBOX = /\b5\.1\.(1|10)\b|user unknown|unknown user|no such user|does not exist|doesn't exist|not exist|invalid recipient|recipient (address )?rejected|address rejected|no mailbox|mailbox not found|mailbox unavailable|unrouteable|undeliverable/i;
const POLICY_REJECTION = /\b5\.7\.\d+\b|spam|block|blacklist|blocklist|listed|reputation|policy|denied|not allowed|relay|authenticat|helo|reverse dns|ptr/i;

/** RCPT cevabını yorumlar: yalnız kutunun olmadığını açıkça söyleyen 5xx "yok" sayılır, engel ve politika cevapları sayılmaz. */
export function classifyRcptReply(reply: SmtpReply | null): MailboxVerdict {
  if (!reply) return 'unknown';
  if (reply.code === 250 || reply.code === 251) return 'exists';
  if (reply.code >= 500 && reply.code < 600 && MISSING_MAILBOX.test(reply.text) && !POLICY_REJECTION.test(reply.text)) return 'missing';
  return 'unknown';
}

/** Tampondaki ilk tam SMTP cevabını ayırır; çok satırlı cevapta ("250-…") son satır "250 …" biçimindedir. */
export function takeReply(buffer: string): { reply: SmtpReply; rest: string } | null {
  const last = /^(\d{3})(?: [^\r\n]*)?\r?\n/m.exec(buffer);
  if (!last) return null;
  const end = last.index + last[0].length;
  return { reply: { code: Number(last[1]), text: buffer.slice(0, end).replace(/\r/g, '').trim() }, rest: buffer.slice(end) };
}

class SmtpConversation {
  private buffer = '';
  private closed = false;
  private waiting: ((reply: SmtpReply | null) => void) | null = null;

  constructor(private readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.flush();
    });
    const end = () => {
      this.closed = true;
      this.flush();
    };
    socket.on('close', end);
    socket.on('error', end);
  }

  private flush() {
    if (!this.waiting) return;
    const taken = takeReply(this.buffer);
    if (!taken && !this.closed) return;
    const resolve = this.waiting;
    this.waiting = null;
    if (taken) this.buffer = taken.rest;
    resolve(taken?.reply ?? null);
  }

  reply(): Promise<SmtpReply | null> {
    return new Promise((resolve) => {
      this.waiting = resolve;
      this.flush();
    });
  }

  send(line: string): Promise<SmtpReply | null> {
    if (this.closed) return Promise.resolve(null);
    this.socket.write(`${line}\r\n`);
    return this.reply();
  }

  close() {
    if (!this.closed) this.socket.write('QUIT\r\n');
    this.socket.destroy();
  }
}

function connect(host: string, port: number, timeoutMs: number): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const fail = () => {
      socket.destroy();
      resolve(null);
    };
    socket.setTimeout(timeoutMs, fail);
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.removeListener('error', fail);
      resolve(socket);
    });
  });
}

const ok = (reply: SmtpReply | null) => !!reply && reply.code >= 200 && reply.code < 300;

/** Bir MX sunucusuyla tek oturum: hedef adresler ve rastgele bir adres sorulur. Sunucu konuşmaya hiç girmezse null. */
async function converse(host: string, domain: string, emails: string[], opts: Required<Omit<ProbeOptions, 'resolveMx'>>) {
  const socket = await connect(host, opts.port, opts.timeoutMs);
  if (!socket) return null;
  const session = new SmtpConversation(socket);
  const deadline = setTimeout(() => socket.destroy(), opts.timeoutMs);
  try {
    if (!ok(await session.reply())) return null;
    if (!ok(await session.send(`EHLO ${opts.helo}`)) && !ok(await session.send(`HELO ${opts.helo}`))) return null;
    if (!ok(await session.send('MAIL FROM:<>'))) return null;
    const verdicts = new Map<string, MailboxVerdict>();
    for (const email of emails) verdicts.set(email, classifyRcptReply(await session.send(`RCPT TO:<${email}>`)));
    const random = classifyRcptReply(await session.send(`RCPT TO:<${randomBytes(9).toString('hex')}@${domain}>`));
    return { verdicts, catchAll: random === 'exists' ? true : random === 'missing' ? false : null };
  } finally {
    clearTimeout(deadline);
    session.close();
  }
}

async function mailHosts(domain: string, resolveMx: (domain: string) => Promise<MxRecord[]>) {
  try {
    const records = await resolveMx(domain);
    return records
      .filter((r) => r.exchange && r.exchange !== '.')
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange.replace(/\.$/, ''));
  } catch {
    return [];
  }
}

/**
 * Aynı alan adındaki adresleri tek oturumda yoklar. Catch-all ya da belirsiz alan adında "var" cevabı "bilinmiyor"a
 * çevrilir; yalnızca olmayan adresi reddeden sunucunun "var" demesi kanıt sayılır.
 */
export async function probeMailboxes(domain: string, emails: string[], opts: ProbeOptions = {}): Promise<MailboxProbe> {
  const targets = [...new Set(emails.map((e) => e.toLowerCase()))].slice(0, MAX_RECIPIENTS);
  const verdicts = new Map<string, MailboxVerdict>(targets.map((e) => [e, 'unknown']));
  const hosts = await mailHosts(domain, opts.resolveMx ?? dns.resolveMx);
  if (!hosts.length) return { mx: false, catchAll: null, verdicts };
  const settings = { port: opts.port ?? SMTP_PORT, timeoutMs: opts.timeoutMs ?? SESSION_TIMEOUT_MS, helo: opts.helo ?? 'localhost' };
  for (const host of hosts.slice(0, MAX_MX_HOSTS)) {
    const result = await converse(host, domain, targets, settings).catch(() => null);
    if (!result) continue;
    for (const [email, verdict] of result.verdicts) verdicts.set(email, verdict === 'exists' && result.catchAll !== false ? 'unknown' : verdict);
    return { mx: true, catchAll: result.catchAll, verdicts };
  }
  return { mx: true, catchAll: null, verdicts };
}
