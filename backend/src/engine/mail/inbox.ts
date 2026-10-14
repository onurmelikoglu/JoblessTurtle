import { MailAccount } from '@prisma/client';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { decryptSecret } from '../../common/crypto';
import { htmlToText, InboundMail } from '../../domain/inbound';

/** Geri dönme bildirimi orijinal iletiyi (CV eki dahil) içerebilir; sınıflandırma ve eşleştirme için ilk kısmı yeterlidir. */
const PARTIAL_SOURCE_BYTES = 160 * 1024;
const FETCH_BATCH = 50;
/** İlan bildirimleri onlarca ilan ve uzun izleme bağlantıları taşır; bu iletilerin daha büyük kısmı indirilir. */
const LARGE_SOURCE_BYTES = 700 * 1024;
const MAX_HTML_CHARS = 600_000;
const CONNECT_TIMEOUT_MS = 30_000;

export interface MailboxCursor {
  uidValidity: string;
  lastUid: number;
}

export interface InboxEnvelope {
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  date: Date;
  fromEmail: string | null;
  fromName: string | null;
  subject: string;
}

export interface FetchedMail extends InboundMail {
  messageId: string | null;
  date: Date;
  raw: string;
  dsn: string;
  /** İletinin HTML gövdesi (varsa); bağlantıları okumak için. */
  html?: string | null;
}

export interface MailboxScan {
  path: string;
  uidValidity: string;
  lastUid: number;
}

export class InboxAuthError extends Error {}

const IMAP_HOSTS: [RegExp, string][] = [
  [/^smtp\.gmail\.com$/i, 'imap.gmail.com'],
  [/^(smtp\.office365\.com|smtp-mail\.outlook\.com|smtp\.live\.com)$/i, 'outlook.office365.com'],
  [/^smtp\.mail\.yahoo\.com$/i, 'imap.mail.yahoo.com'],
  [/^smtp\.yandex\.(com|ru|com\.tr)$/i, 'imap.yandex.com'],
  [/^smtp\.zoho\.(com|eu)$/i, 'imap.zoho.com'],
];

export function imapHostFor(account: Pick<MailAccount, 'smtpHost'>): string | null {
  const smtp = account.smtpHost?.trim();
  if (!smtp) return null;
  for (const [re, host] of IMAP_HOSTS) if (re.test(smtp)) return host;
  return smtp.replace(/^smtp[.-]/i, 'imap.');
}

export function canReadInbox(account: Pick<MailAccount, 'provider' | 'smtpHost' | 'encryptedSecret'>) {
  return account.provider === 'smtp' && !!account.encryptedSecret && !!imapHostFor(account);
}

function address(list: { name?: string; address?: string }[] | undefined) {
  const first = list?.[0];
  return { email: first?.address?.toLowerCase() ?? null, name: first?.name ?? null };
}

/** DSN alanları (Status, Diagnostic-Code, Final-Recipient) ham iletide düz metin olarak durur. */
function dsnLines(raw: string) {
  const out: string[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^(Status|Diagnostic-Code|Final-Recipient|Original-Recipient|Action|Remote-MTA|X-Failed-Recipients):/i.test(lines[i])) continue;
    let line = lines[i];
    while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) line += ' ' + lines[++i].trim();
    out.push(line);
  }
  return out.join('\n');
}

export class InboxReader {
  private client: ImapFlow;

  constructor(account: MailAccount) {
    this.client = new ImapFlow({
      host: imapHostFor(account)!,
      port: 993,
      secure: true,
      auth: { user: account.smtpUser ?? account.accountEmail, pass: decryptSecret(account.encryptedSecret!) },
      logger: false,
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: 120_000,
    });
    this.client.on('error', () => undefined);
  }

  async connect() {
    try {
      await this.client.connect();
    } catch (e: any) {
      if (e?.authenticationFailed || /auth/i.test(String(e?.responseText ?? e?.message ?? ''))) throw new InboxAuthError('Gelen kutusuna giriş yapılamadı; uygulama şifresi veya IMAP erişimi kontrol edilmeli');
      throw e;
    }
  }

  async close() {
    await this.client.logout().catch(() => this.client.close());
  }

  /** Gelen kutusu ve istenmeyen klasörü; başvuru yanıtları bazen spam klasörüne düşer. */
  async mailboxes(): Promise<string[]> {
    const list = await this.client.list();
    const junk = list.find((m) => m.specialUse === '\\Junk')?.path;
    return ['INBOX', ...(junk ? [junk] : [])];
  }

  async scan(
    path: string,
    cursor: MailboxCursor | null,
    since: Date,
    onEnvelopes: (envelopes: InboxEnvelope[]) => Promise<number[]>,
    onMail: (mail: FetchedMail) => Promise<void>,
    large: (envelope: InboxEnvelope) => boolean = () => false,
  ): Promise<MailboxScan> {
    const lock = await this.client.getMailboxLock(path, { readOnly: true });
    try {
      const mailbox = this.client.mailbox;
      const uidValidity = mailbox ? String(mailbox.uidValidity) : '0';
      const fresh = !cursor || cursor.uidValidity !== uidValidity;
      const found = fresh ? await this.client.search({ since }, { uid: true }) : await this.client.search({ uid: `${cursor!.lastUid + 1}:*` }, { uid: true });
      const uids = (found || []).filter((u) => fresh || u > cursor!.lastUid).sort((a, b) => a - b);
      let lastUid = fresh ? 0 : cursor!.lastUid;
      for (let i = 0; i < uids.length; i += FETCH_BATCH) {
        const batch = uids.slice(i, i + FETCH_BATCH);
        const envelopes: InboxEnvelope[] = [];
        for await (const m of this.client.fetch(batch.join(','), { uid: true, envelope: true, internalDate: true }, { uid: true })) {
          const from = address(m.envelope?.from);
          envelopes.push({
            uid: m.uid,
            messageId: m.envelope?.messageId?.toLowerCase() ?? null,
            inReplyTo: m.envelope?.inReplyTo?.toLowerCase() ?? null,
            date: new Date(m.envelope?.date ?? m.internalDate ?? Date.now()),
            fromEmail: from.email,
            fromName: from.name,
            subject: m.envelope?.subject ?? '',
          });
        }
        const wanted = await onEnvelopes(envelopes);
        const byUid = new Map(envelopes.map((e) => [e.uid, e]));
        const groups: [number[], number][] = [
          [wanted.filter((uid) => !large(byUid.get(uid)!)), PARTIAL_SOURCE_BYTES],
          [wanted.filter((uid) => large(byUid.get(uid)!)), LARGE_SOURCE_BYTES],
        ];
        for (const [uidsOfSize, maxLength] of groups) {
          if (!uidsOfSize.length) continue;
          for await (const m of this.client.fetch(uidsOfSize.join(','), { uid: true, source: { start: 0, maxLength } }, { uid: true })) {
            if (!m.source) continue;
            await onMail(await parseMail(m.source, byUid.get(m.uid)!));
          }
        }
        lastUid = Math.max(lastUid, ...batch);
      }
      if (fresh && !uids.length) lastUid = Math.max(0, Number(mailbox ? mailbox.uidNext : 1) - 1);
      return { path, uidValidity, lastUid };
    } finally {
      lock.release();
    }
  }
}

function headerText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  const v = value as { value?: unknown; text?: unknown; params?: Record<string, string> } | null;
  if (typeof v?.value === 'string') {
    const params = Object.entries(v.params ?? {}).map(([k, p]) => `; ${k}="${p}"`);
    return v.value + params.join('');
  }
  if (typeof v?.text === 'string') return v.text;
  return String(value ?? '');
}

export async function parseMail(source: Buffer, envelope: Pick<InboxEnvelope, 'messageId' | 'date' | 'fromEmail' | 'fromName' | 'subject'>): Promise<FetchedMail> {
  const raw = source.toString('utf8');
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true }).catch(() => null);
  const headers: Record<string, string> = {};
  for (const [key, value] of parsed?.headers ?? new Map()) headers[key.toLowerCase()] = headerText(value);
  const text = (parsed?.text?.trim() || (typeof parsed?.html === 'string' ? htmlToText(parsed.html) : '')).slice(0, 30_000);
  const from = parsed?.from?.value?.[0];
  return {
    messageId: envelope.messageId ?? parsed?.messageId?.toLowerCase() ?? null,
    date: envelope.date,
    fromEmail: envelope.fromEmail ?? from?.address?.toLowerCase() ?? null,
    fromName: envelope.fromName ?? from?.name ?? null,
    subject: envelope.subject || parsed?.subject || '',
    text,
    headers,
    contentType: headers['content-type'] ?? null,
    raw,
    dsn: dsnLines(raw),
    html: typeof parsed?.html === 'string' ? parsed.html.slice(0, MAX_HTML_CHARS) : null,
  };
}
