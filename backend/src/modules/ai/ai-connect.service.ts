import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { env } from '../../common/env';
import { AppError } from '../../common/errors';
import type { ConnectProvider, ConnectStatus as ConnectStatusWire, LoginSession as LoginSessionWire } from '../../contracts/ai-setup';
import type { ServerShape } from '../../contracts/wire';

type LoginSession = ServerShape<LoginSessionWire>;
type ConnectStatus = ServerShape<ConnectStatusWire>;
import { AiService } from '../../engine/ai/ai.service';
import { resetProviderCache } from '../../engine/ai/providers';

export const CONNECT_PROVIDERS: ConnectProvider[] = ['cli_claude', 'cli_codex'];

export type Spawner = (command: string, args: string[]) => ChildProcessWithoutNullStreams;

interface ActiveLogin {
  child: ChildProcessWithoutNullStreams;
  session: LoginSession;
  output: string;
  exited: Promise<number | null>;
  timer: NodeJS.Timeout;
  expired: boolean;
  /** Kod gönderildiğinde çıktının uzunluğu; hata mesajı yalnızca bundan sonraki satırlardan alınır. */
  codeSentAt: number | null;
}

/** Giriş adresi ya da kodu bu sürede gelmezse başlatma başarısız sayılır. */
const START_WAIT_MS = 30_000;
/** Giriş bağlantıları ve ChatGPT cihaz kodu 15 dakika geçerli; süreç de en çok bu kadar bekletilir. */
const LOGIN_TTL_MS = 15 * 60_000;
const VERIFY_WAIT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 20_000;
const STATUS_CACHE_MS = 10_000;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export const stripAnsi = (text: string) => text.replace(ANSI, '');

/** Claude: "…/oauth/authorize?…" adresi. ChatGPT: "https://auth.openai.com/codex/device" ve "ABCD-1234" biçimli kod. */
export function parseLoginPrompt(provider: ConnectProvider, raw: string): { url: string | null; userCode: string | null } {
  const text = stripAnsi(raw);
  const urls = text.match(/https:\/\/[^\s"'<>]+/g) ?? [];
  if (provider === 'cli_claude') return { url: urls.find((u) => u.includes('/oauth/authorize')) ?? null, userCode: null };
  return { url: urls.find((u) => u.includes('auth.openai.com')) ?? null, userCode: text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/)?.[1] ?? null };
}

/** `claude auth status --json` çıktısı. */
export function parseClaudeStatus(raw: string): { connected: boolean; account: string | null; plan: string | null } {
  try {
    const data = JSON.parse(stripAnsi(raw).trim()) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
    return { connected: data.loggedIn === true, account: data.email ?? null, plan: data.subscriptionType ?? null };
  } catch {
    return { connected: false, account: null, plan: null };
  }
}

/** `codex login status`: girişliyken "Logged in using ChatGPT", değilken "Not logged in" (çıkış kodu 1). */
export function parseCodexStatus(code: number | null, raw: string): { connected: boolean; account: string | null; plan: string | null } {
  const text = stripAnsi(raw).trim();
  const connected = code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text);
  const method = text.match(/logged in using (.+)/i)?.[1]?.trim() ?? null;
  return { connected, account: null, plan: connected ? method : null };
}

/** Söz verilen sonucu en çok `ms` kadar bekler; zamanlayıcı süreci açık tutmasın diye temizlenir. */
async function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}

/** Çıktıdaki adresler ve uzun belirteç benzeri dizgiler (kod, token) kullanıcıya gösterilmeden önce gizlenir. */
export function redactSecrets(text: string): string {
  return text.replace(/https?:\/\/\S+/g, '[adres]').replace(/[A-Za-z0-9_\-.#~+/=]{24,}/g, '[gizli]');
}

/** Son anlamlı çıktı satırları; başarısız girişte kullanıcıya gösterilir. */
export function lastLines(raw: string, count = 3): string {
  return redactSecrets(stripAnsi(raw))
    .split('\n')
    .map((l) => l.trim())
    .map((l) => l.replace(/^paste code here if prompted\s*>\s*/i, ''))
    .filter((l) => l && !l.includes('[adres]'))
    .slice(-count)
    .join(' ')
    .slice(0, 300);
}

/**
 * Claude Code ve Codex CLI'ye arayüzden giriş. Komutlar API sürecinde çalışır; giriş bilgileri worker ile ortak ev
 * klasörüne (ai-cli-home) yazılır, worker aynı hesabı kullanır. Sunucuda aynı anda tek giriş oturumu tutulur; hiçbir
 * kod ya da token veritabanına ya da loga yazılmaz. Bağlantı değişince worker'ın kurulu sağlayıcı listesi tazelenir.
 */
@Injectable()
export class AiConnectService implements OnApplicationShutdown {
  constructor(private readonly ai: AiService) {}

  /** Testlerde gerçek CLI yerine sahte süreç verilir. */
  spawner: Spawner = (command, args) => spawn(command, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });

  private readonly logins = new Map<ConnectProvider, ActiveLogin>();
  private readonly statusCache = new Map<ConnectProvider, { at: number; value: Omit<ConnectStatus, 'login'> }>();

  onApplicationShutdown() {
    for (const provider of CONNECT_PROVIDERS) this.cancel(provider);
  }

  private command(provider: ConnectProvider): string {
    return provider === 'cli_claude' ? env().CLAUDE_CLI_PATH : env().CODEX_CLI_PATH;
  }

  private run(provider: ConnectProvider, args: string[]): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      let output = '';
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawner(this.command(provider), args);
      } catch (e) {
        resolve({ code: null, output: (e as Error).message });
        return;
      }
      const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS);
      child.stdout.on('data', (d) => (output += d.toString()));
      child.stderr.on('data', (d) => (output += d.toString()));
      child.stdin.on('error', () => undefined);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: null, output: e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
      child.stdin.end();
    });
  }

  private async probe(provider: ConnectProvider, fresh = false): Promise<Omit<ConnectStatus, 'login'>> {
    const hit = this.statusCache.get(provider);
    if (!fresh && hit && Date.now() - hit.at < STATUS_CACHE_MS) return hit.value;
    const version = await this.run(provider, ['--version']);
    let value: Omit<ConnectStatus, 'login'>;
    if (version.code !== 0) {
      value = { provider, installed: false, connected: false, account: null, plan: null };
    } else if (provider === 'cli_claude') {
      const status = await this.run(provider, ['auth', 'status', '--json']);
      value = { provider, installed: true, ...parseClaudeStatus(status.output) };
    } else {
      const status = await this.run(provider, ['login', 'status']);
      value = { provider, installed: true, ...parseCodexStatus(status.code, status.output) };
    }
    this.statusCache.set(provider, { at: Date.now(), value });
    return value;
  }

  async status(provider: ConnectProvider, fresh = false): Promise<ConnectStatus> {
    const probed = await this.probe(provider, fresh);
    return { ...probed, login: this.logins.get(provider)?.session ?? null };
  }

  async statuses(): Promise<ConnectStatus[]> {
    return Promise.all(CONNECT_PROVIDERS.map((p) => this.status(p)));
  }

  /** Girişi başlatır; giriş adresi (ChatGPT'de kod da) çıktıya düşünce döner. Önceki yarım giriş iptal edilir. */
  async start(provider: ConnectProvider): Promise<ConnectStatus> {
    if (!(await this.probe(provider, true)).installed) throw new AppError(409, 'AI_CLI_MISSING', 'Bu kurulumda yapay zekâ aracı yok. install.sh ile kurulumda gelir; elle kurulumda .env içinde INSTALL_AI_CLI=true yapıp imajı yeniden derle.');
    for (const other of CONNECT_PROVIDERS) this.cancel(other);

    const args = provider === 'cli_claude' ? ['auth', 'login', '--claudeai'] : ['login', '--device-auth'];
    const child = this.spawner(this.command(provider), args);
    const session: LoginSession = { phase: 'starting', url: null, userCode: null, needsCode: provider === 'cli_claude', message: null, expiresAt: new Date(Date.now() + LOGIN_TTL_MS) };
    let ready: () => void = () => undefined;
    const prompted = new Promise<void>((resolve) => (ready = resolve));
    const login: ActiveLogin = {
      child,
      session,
      output: '',
      exited: new Promise((resolve) => {
        child.on('close', (code) => resolve(code));
        child.on('error', (e) => {
          login.output += `\n${e.message}`;
          resolve(null);
        });
      }),
      timer: setTimeout(() => {
        login.expired = true;
        child.kill('SIGKILL');
      }, LOGIN_TTL_MS),
      expired: false,
      codeSentAt: null,
    };
    this.logins.set(provider, login);

    const onData = (d: Buffer) => {
      login.output += d.toString();
      const parsed = parseLoginPrompt(provider, login.output);
      session.url ??= parsed.url;
      session.userCode ??= parsed.userCode;
      if (session.url && (provider === 'cli_claude' || session.userCode)) {
        if (session.phase === 'starting') session.phase = 'waiting';
        ready();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.on('error', () => undefined);
    void login.exited.then((code) => this.finish(provider, login, code));

    await waitAtMost(Promise.race([prompted, login.exited]), START_WAIT_MS);
    if (session.phase === 'starting') {
      session.phase = 'failed';
      session.message = lastLines(login.output) || 'Giriş adresi alınamadı.';
      child.kill('SIGKILL');
    }
    return this.status(provider);
  }

  private finish(provider: ConnectProvider, login: ActiveLogin, code: number | null) {
    clearTimeout(login.timer);
    if (this.logins.get(provider) !== login) return;
    this.statusCache.delete(provider);
    resetProviderCache();
    if (code === 0) {
      this.logins.delete(provider);
      void this.ai.markProvidersChanged().catch(() => undefined);
      return;
    }
    if (login.expired) {
      login.session.phase = 'expired';
      login.session.message = 'Giriş süresi (15 dakika) doldu. Yeniden başlat.';
      return;
    }
    login.session.phase = 'failed';
    login.session.message ??= lastLines(login.output.slice(login.codeSentAt ?? 0)) || 'Giriş tamamlanmadı.';
  }

  /** Claude: giriş sayfasının verdiği kodu bekleyen sürece iletir ve sonucu bekler. */
  async submitCode(provider: ConnectProvider, code: string): Promise<ConnectStatus> {
    const login = this.logins.get(provider);
    if (!login || !login.session.needsCode || login.session.phase !== 'waiting') throw new AppError(409, 'AI_LOGIN_NOT_WAITING', 'Kod bekleyen bir giriş yok; girişi yeniden başlat.');
    login.session.phase = 'verifying';
    login.codeSentAt = login.output.length;
    login.child.stdin.write(`${code.trim()}\n`);
    await waitAtMost(login.exited, VERIFY_WAIT_MS);
    if (this.logins.get(provider) === login && login.session.phase === 'verifying') {
      login.session.phase = 'failed';
      login.session.message = 'Kod doğrulanamadı (zaman aşımı). Girişi yeniden başlat.';
      login.child.kill('SIGKILL');
    }
    return this.status(provider, true);
  }

  cancel(provider: ConnectProvider) {
    const login = this.logins.get(provider);
    if (!login) return;
    this.logins.delete(provider);
    clearTimeout(login.timer);
    login.child.kill('SIGKILL');
  }

  async logout(provider: ConnectProvider): Promise<ConnectStatus> {
    this.cancel(provider);
    const result = await this.run(provider, provider === 'cli_claude' ? ['auth', 'logout'] : ['logout']);
    if (result.code !== 0) throw new AppError(502, 'AI_LOGOUT_FAILED', lastLines(result.output) || 'Çıkış yapılamadı.');
    await this.ai.markProvidersChanged();
    return this.status(provider, true);
  }
}
