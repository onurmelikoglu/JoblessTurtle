import { MailAccount } from '@prisma/client';
import * as nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { decryptSecret } from '../../common/crypto';
import { env } from '../../common/env';

export interface OutgoingMail {
  from: string;
  fromName?: string | null;
  to: string;
  subject: string;
  text: string;
  attachments: { filename: string; content: Buffer; contentType: string }[];
  headers: Record<string, string>;
}

export interface SendResult {
  providerMessageId: string;
  threadId?: string | null;
}

/** Sağlayıcı iletiyi kesin olarak reddetti (gönderilmedi). */
export class MailDefiniteError extends Error {
  constructor(
    message: string,
    public readonly code = 'PROVIDER_REJECTED',
    public readonly accountProblem = false,
  ) {
    super(message);
    this.name = 'MailDefiniteError';
  }
}

/** Kabulün gerçekleşip gerçekleşmediği bilinmiyor → submission_unknown; otomatik tekrar yok. */
export class MailUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailUnknownError';
  }
}

/** Gmail API ham ileti sınırı ~25MB (base64 dahil). SMTP için de aynı güvenli sınır. */
export const MAX_RAW_BYTES = 24 * 1024 * 1024;

export async function buildMime(mail: OutgoingMail): Promise<Buffer> {
  const composer = new MailComposer({
    from: mail.fromName ? { name: mail.fromName, address: mail.from } : mail.from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    headers: mail.headers,
    attachments: mail.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
  });
  return new Promise((resolve, reject) => composer.compile().build((err, msg) => (err ? reject(err) : resolve(msg))));
}

export function estimateRawSize(bodyLength: number, attachmentBytes: number[]): number {
  return Math.ceil(attachmentBytes.reduce((s, b) => s + b, 0) * 1.37) + bodyLength * 2 + 4096;
}

export interface MailProvider {
  send(account: MailAccount, mail: OutgoingMail): Promise<SendResult>;
}

/** Test/pilot sağlayıcısı: gerçek e-posta göndermez. "+timeout" ve "+reject" alıcıları hata senaryolarını simüle eder. */
export const fakeProvider: MailProvider = {
  async send(_account, mail) {
    await new Promise((r) => setTimeout(r, 50));
    if (/\+timeout@/i.test(mail.to)) throw new MailUnknownError('Fake: bağlantı zaman aşımı (kabul durumu bilinmiyor)');
    if (/\+reject@/i.test(mail.to)) throw new MailDefiniteError('Fake: sağlayıcı iletiyi reddetti');
    const raw = await buildMime(mail);
    if (raw.length > MAX_RAW_BYTES) throw new MailDefiniteError('İleti boyutu sağlayıcı sınırını aşıyor', 'ATTACHMENT_TOO_LARGE');
    return { providerMessageId: `fake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, threadId: null };
  },
};

// ───────────── Gmail (OAuth, yalnızca gmail.send) ─────────────

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'openid', 'email'];

export function gmailRedirectUri() {
  return `${env().APP_PUBLIC_URL.replace(/\/$/, '')}/api/v1/mail-accounts/gmail/callback`;
}

export function gmailAuthUrl(state: string) {
  const p = new URLSearchParams({
    client_id: env().GOOGLE_CLIENT_ID ?? '',
    redirect_uri: gmailRedirectUri(),
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: GMAIL_SCOPES.join(' '),
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

export async function gmailExchangeCode(code: string) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env().GOOGLE_CLIENT_ID ?? '',
      client_secret: env().GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: gmailRedirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(data.error_description ?? data.error ?? 'Token alınamadı');
  let email: string | null = null;
  if (data.id_token) {
    const payload = JSON.parse(Buffer.from(String(data.id_token).split('.')[1], 'base64url').toString('utf8'));
    email = payload.email ?? null;
  }
  return { refreshToken: data.refresh_token as string | undefined, scope: String(data.scope ?? ''), email };
}

async function gmailAccessToken(refreshToken: string) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env().GOOGLE_CLIENT_ID ?? '',
      client_secret: env().GOOGLE_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new MailDefiniteError(`Gmail yetkisi yenilenemedi: ${data.error ?? res.status}`, 'ACCOUNT_REAUTH', true);
  return String(data.access_token);
}

export async function gmailRevoke(refreshToken: string) {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' }).catch(() => undefined);
}

export const gmailProvider: MailProvider = {
  async send(account, mail) {
    if (!account.encryptedSecret) throw new MailDefiniteError('Gmail hesabı yeniden bağlanmalı', 'ACCOUNT_REAUTH', true);
    const accessToken = await gmailAccessToken(decryptSecret(account.encryptedSecret));
    const raw = await buildMime(mail);
    if (raw.length > MAX_RAW_BYTES) throw new MailDefiniteError('İleti boyutu Gmail sınırını aşıyor; büyük portföy için bağlantı kullanın', 'ATTACHMENT_TOO_LARGE');
    let res: Response;
    try {
      res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw: raw.toString('base64url') }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      // İstek gönderildikten sonra bağlantı koptuysa kabul durumu bilinmez.
      throw new MailUnknownError(`Gmail isteği tamamlanamadı: ${(e as Error).message}`);
    }
    const data: any = await res.json().catch(() => ({}));
    if (res.ok) return { providerMessageId: String(data.id), threadId: data.threadId ?? null };
    if (res.status === 401 || res.status === 403) throw new MailDefiniteError(`Gmail yetki hatası (${res.status})`, 'ACCOUNT_REAUTH', true);
    if (res.status >= 500) throw new MailUnknownError(`Gmail sunucu hatası ${res.status}`);
    throw new MailDefiniteError(`Gmail reddetti (${res.status}): ${data?.error?.message ?? ''}`);
  },
};

// ───────────── SMTP (TLS + uygulama parolası) ─────────────

export async function verifySmtp(config: { host: string; port: number; secure: boolean; user: string; pass: string }) {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 15_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.verify();
  } catch (e: any) {
    if (e?.code === 'EAUTH') throw new MailDefiniteError('Mail adresi veya uygulama parolası hatalı', 'ACCOUNT_REAUTH', true);
    throw new MailDefiniteError(`Mail sunucusuna bağlanılamadı: ${e?.message ?? e}`);
  } finally {
    transport.close();
  }
}

export const smtpProvider: MailProvider = {
  async send(account, mail) {
    if (!account.encryptedSecret || !account.smtpHost) throw new MailDefiniteError('SMTP bilgileri eksik', 'ACCOUNT_REAUTH', true);
    const transport = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort ?? 465,
      secure: account.smtpSecure,
      requireTLS: !account.smtpSecure,
      auth: { user: account.smtpUser ?? account.accountEmail, pass: decryptSecret(account.encryptedSecret) },
      connectionTimeout: 20_000,
      socketTimeout: 60_000,
    });
    const raw = await buildMime(mail);
    if (raw.length > MAX_RAW_BYTES) throw new MailDefiniteError('İleti boyutu sınırı aşıyor', 'ATTACHMENT_TOO_LARGE');
    try {
      const info = await transport.sendMail({ envelope: { from: mail.from, to: [mail.to] }, raw });
      return { providerMessageId: info.messageId ?? `smtp-${Date.now()}`, threadId: null };
    } catch (e: any) {
      if (e?.code === 'EAUTH') throw new MailDefiniteError('SMTP kimlik doğrulaması başarısız', 'ACCOUNT_REAUTH', true);
      // Yalnızca ileti verilmeden önceki bağlantı hataları kesin başarısızlıktır; DATA sonrası kopma belirsizdir.
      const beforeData = e?.command === 'CONN' || ['ECONNREFUSED', 'EDNS'].includes(e?.code);
      if (beforeData && !e?.responseCode) throw new MailDefiniteError(`SMTP bağlantısı kurulamadı: ${e.message}`);
      if (typeof e?.responseCode === 'number' && e.responseCode >= 500) throw new MailDefiniteError(`SMTP reddetti (${e.responseCode})`);
      throw new MailUnknownError(`SMTP sonucu belirsiz: ${e?.message ?? e}`);
    } finally {
      transport.close();
    }
  },
};

export function mailProviderFor(provider: string): MailProvider {
  switch (provider) {
    case 'gmail':
      return gmailProvider;
    case 'smtp':
      return smtpProvider;
    case 'fake':
      if (!env().FAKE_MAIL_ENABLED) throw new MailDefiniteError('Fake sağlayıcı devre dışı');
      return fakeProvider;
    default:
      throw new MailDefiniteError(`Desteklenmeyen sağlayıcı: ${provider}`);
  }
}
