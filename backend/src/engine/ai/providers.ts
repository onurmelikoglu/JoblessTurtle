import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { env } from '../../common/env';
import { AiKind } from './schemas';

export type ProviderName = 'cli_claude' | 'cli_codex' | 'manual' | 'ollama' | 'anthropic_api' | 'openai_api' | 'template';

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  cli_claude: 'Claude Code CLI (kendi aboneliğin)',
  cli_codex: 'Codex CLI (ChatGPT hesabın)',
  manual: 'Manuel köprü (sohbete kopyala-yapıştır)',
  ollama: 'Yerel model (Ollama)',
  anthropic_api: 'Claude API (anahtar)',
  openai_api: 'OpenAI API (anahtar)',
  template: 'Şablon (AI yok)',
};

export interface ProviderFile {
  name: string;
  data: Buffer;
}

export interface ProviderRunOptions {
  kind: AiKind;
  webResearch?: boolean;
  files?: ProviderFile[];
  model?: string;
}

export interface ProviderUsage {
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd?: number | null;
}

export interface ProviderLimitWindow {
  name: string;
  utilization: number;
  resetsAt: Date;
}

export interface ProviderResult {
  text: string;
  usage?: ProviderUsage;
  limits?: ProviderLimitWindow[];
}

export class ProviderLimitError extends Error {
  constructor(
    message: string,
    public readonly resetAt: Date | null = null,
  ) {
    super(message);
  }
}

const LIMIT_PATTERN = /(usage limit|rate limit|rate_limit|quota|429|too many requests|limit reached|limit will reset|credit balance)/i;
export const WEB_RESEARCH_KINDS: AiKind[] = ['company_report', 'company_discovery', 'company_lookup', 'company_contacts', 'company_sizes', 'job_search'];

/** Claude "…|<epoch>" ve Codex "try again at Oct 10th, 2026 12:15 AM" (CLI'nin yerel saatiyle) biçimlerini okur. */
export function limitResetAt(text: string): Date | null {
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const human = text.match(/try again at ([A-Z][a-z]{2,8}) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? (\d{1,2}:\d{2}\s?[AP]M)/i);
  if (!human) return null;
  const at = new Date(`${human[1]} ${human[2]}, ${human[3]} ${human[4]}`);
  return Number.isNaN(at.getTime()) ? null : at;
}

export interface TextProvider {
  name: ProviderName;
  /** Yalnızca sunucu sahibinin workspace'inde kullanılabilir mi (kişisel abonelik). */
  ownerOnly: boolean;
  available(): Promise<{ ok: boolean; detail: string }>;
  complete(prompt: string, opts: ProviderRunOptions): Promise<ProviderResult>;
}

function runProcess(cmd: string, args: string[], stdin: string, timeoutMs: number, files: ProviderFile[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Boş geçici dizinde çalıştırılır; CLI'nin proje dosyalarına erişimi olmaz.
    const cwd = mkdtempSync(path.join(tmpdir(), 'ai-cli-'));
    for (const f of files) writeFileSync(path.join(cwd, path.basename(f.name)), f.data);
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
    // Süreç stdin'i okumadan kapanabilir (ör. --version); EPIPE yok sayılır.
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  });
}

const availabilityCache = new Map<string, { at: number; value: { ok: boolean; detail: string } }>();
async function cached(key: string, fn: () => Promise<{ ok: boolean; detail: string }>) {
  const hit = availabilityCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  let value: { ok: boolean; detail: string };
  try {
    value = await fn();
  } catch (e) {
    value = { ok: false, detail: (e as Error).message };
  }
  availabilityCache.set(key, { at: Date.now(), value });
  return value;
}

/** stream-json çıktısından son sonuç olayını ve abonelik kullanım pencerelerini (5 saatlik, haftalık) ayıklar. */
export function parseClaudeStream(stdout: string) {
  let result: any = null;
  const windows = new Map<string, ProviderLimitWindow>();
  const add = (name: string, utilization: unknown, resetsAt: unknown) => {
    if (typeof utilization === 'number' && typeof resetsAt === 'number') windows.set(name, { name, utilization, resetsAt: new Date(resetsAt * 1000) });
  };
  for (const line of stdout.split('\n')) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'result') result = event;
    if (event.type === 'rate_limit_event') {
      const info = event.rate_limit_info ?? {};
      if (info.unifiedWindows) for (const [name, w] of Object.entries(info.unifiedWindows as Record<string, { utilization?: number; resetsAt?: number }>)) add(name, w.utilization, w.resetsAt);
      else add(info.rateLimitType ?? 'unknown', info.utilization, info.resetsAt);
    }
  }
  return { result, limits: [...windows.values()] };
}

/** Claude Code CLI: `claude -p` başsız mod. Giriş host üzerinde `claude` ile bir kez yapılır. */
export const cliClaudeProvider: TextProvider = {
  name: 'cli_claude',
  ownerOnly: true,
  available: () =>
    cached('cli_claude', async () => {
      const r = await runProcess(env().CLAUDE_CLI_PATH, ['--version'], '', 15000);
      return r.code === 0 ? { ok: true, detail: r.stdout.trim() } : { ok: false, detail: r.stderr.trim() || 'claude bulunamadı' };
    }),
  async complete(prompt, opts) {
    const webTools = WEB_RESEARCH_KINDS.includes(opts.kind) && opts.webResearch && env().AI_CLI_WEB_RESEARCH ? 'WebSearch,WebFetch' : '';
    const tools = opts.files?.length ? 'Read' : webTools;
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--model', opts.model ?? env().CLAUDE_CLI_MODEL, '--tools', tools, ...(tools ? ['--allowedTools', tools] : [])];
    const r = await runProcess(env().CLAUDE_CLI_PATH, args, prompt, env().AI_CLI_TIMEOUT_SECONDS * 1000, opts.files);
    const { result: parsed, limits } = parseClaudeStream(r.stdout);
    const failure = r.code !== 0 || parsed?.is_error;
    if (failure) {
      const message = String(parsed?.result ?? (r.stderr.slice(0, 400) || r.stdout.slice(0, 400)));
      if (LIMIT_PATTERN.test(message)) throw new ProviderLimitError(`Claude limiti: ${message.slice(0, 200)}`, limitResetAt(message));
      throw new Error(`claude CLI hata kodu ${r.code}: ${message}`);
    }
    if (!parsed) throw new Error('claude CLI çıktısı çözümlenemedi');
    const models = Object.entries((parsed.modelUsage ?? {}) as Record<string, { costUSD?: number }>).sort((a, b) => (b[1].costUSD ?? 0) - (a[1].costUSD ?? 0));
    return {
      text: String(parsed.result ?? ''),
      usage: {
        model: models[0]?.[0] ?? opts.model ?? null,
        inputTokens: parsed.usage?.input_tokens ?? null,
        outputTokens: parsed.usage?.output_tokens ?? null,
        cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? null,
        cacheWriteTokens: parsed.usage?.cache_creation_input_tokens ?? null,
        costUsd: parsed.total_cost_usd ?? null,
      },
      limits,
    };
  },
};

function parseCodexEvents(stdout: string) {
  let text = '';
  let usage: ProviderUsage | undefined;
  let error: string | null = null;
  for (const line of stdout.split('\n')) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = String(event.item.text ?? text);
    if (event.type === 'turn.completed' && event.usage) {
      usage = { inputTokens: event.usage.input_tokens ?? null, outputTokens: event.usage.output_tokens ?? null, cacheReadTokens: event.usage.cached_input_tokens ?? null };
    }
    if (event.type === 'error' || event.type === 'turn.failed') error = String(event.message ?? event.error?.message ?? 'codex hatası');
  }
  return { text, usage, error };
}

/** Çok adımlı web araştırması gereken görevlerde varsayılan "low" akıl yürütme yetersiz kalıyor. */
const CODEX_REASONING: Partial<Record<string, string>> = { company_contacts: 'medium' };

/** Codex CLI: ChatGPT hesabıyla `codex login --device-auth` sonrası başsız çalıştırma. */
export const cliCodexProvider: TextProvider = {
  name: 'cli_codex',
  ownerOnly: true,
  available: () =>
    cached('cli_codex', async () => {
      const version = await runProcess(env().CODEX_CLI_PATH, ['--version'], '', 15000);
      if (version.code !== 0) return { ok: false, detail: version.stderr.trim() || 'codex bulunamadı' };
      const status = await runProcess(env().CODEX_CLI_PATH, ['login', 'status'], '', 15000);
      const loggedIn = status.code === 0 && !/not logged in/i.test(status.stdout + status.stderr);
      return loggedIn ? { ok: true, detail: version.stdout.trim() } : { ok: false, detail: 'ChatGPT girişi yapılmamış (codex login --device-auth)' };
    }),
  async complete(prompt, opts) {
    const web = WEB_RESEARCH_KINDS.includes(opts.kind) && opts.webResearch && env().AI_CLI_WEB_RESEARCH;
    const run = (model?: string) =>
      runProcess(
        env().CODEX_CLI_PATH,
        [
          ...(web ? ['--search'] : []),
          'exec',
          '--skip-git-repo-check',
          '--ephemeral',
          '--json',
          '-s',
          'read-only',
          ...(model ? ['-m', model] : []),
          ...(CODEX_REASONING[opts.kind] ? ['-c', `model_reasoning_effort="${CODEX_REASONING[opts.kind]}"`] : []),
          '-',
        ],
        prompt,
        env().AI_CLI_TIMEOUT_SECONDS * 1000,
        opts.files,
      );
    let r = await run(opts.model);
    let parsed = parseCodexEvents(r.stdout);
    if (opts.model && (r.code !== 0 || parsed.error) && /model/i.test(parsed.error ?? r.stderr)) {
      r = await run();
      parsed = parseCodexEvents(r.stdout);
    }
    const failure = parsed.error ?? (r.code !== 0 ? r.stderr.slice(0, 400) || `kod ${r.code}` : null);
    if (failure) {
      if (LIMIT_PATTERN.test(failure)) throw new ProviderLimitError(`ChatGPT limiti: ${failure.slice(0, 200)}`, limitResetAt(failure));
      throw new Error(`codex CLI hatası: ${failure}`);
    }
    return { text: parsed.text || r.stdout, usage: { ...parsed.usage, model: opts.model ?? null } };
  },
};

export const ollamaProvider: TextProvider = {
  name: 'ollama',
  ownerOnly: false,
  available: () =>
    cached('ollama', async () => {
      if (!env().OLLAMA_URL) return { ok: false, detail: 'OLLAMA_URL tanımlı değil' };
      const res = await fetch(`${env().OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
      return res.ok ? { ok: true, detail: `model: ${env().OLLAMA_MODEL}` } : { ok: false, detail: `HTTP ${res.status}` };
    }),
  async complete(prompt) {
    const res = await fetch(`${env().OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: env().OLLAMA_MODEL, stream: false, format: 'json', messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(env().AI_CLI_TIMEOUT_SECONDS * 1000),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data: any = await res.json();
    return { text: String(data?.message?.content ?? ''), usage: { model: env().OLLAMA_MODEL, inputTokens: data?.prompt_eval_count ?? null, outputTokens: data?.eval_count ?? null } };
  },
};

let anthropicClient: Anthropic | null = null;

export const anthropicApiProvider: TextProvider = {
  name: 'anthropic_api',
  ownerOnly: false,
  available: async () => (env().ANTHROPIC_API_KEY ? { ok: true, detail: `model: ${env().ANTHROPIC_MODEL}` } : { ok: false, detail: 'ANTHROPIC_API_KEY tanımlı değil' }),
  async complete(prompt, opts) {
    anthropicClient ??= new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });
    // Güvenlik sınıflandırıcısı reddederse sunucu tarafı yedek modele geçilir (fallbacks: 'default').
    const response = await anthropicClient.beta.messages.create({
      model: opts.model ?? env().ANTHROPIC_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'refusal') throw new Error('Model isteği reddetti');
    return {
      text: response.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
      usage: { model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, cacheReadTokens: response.usage.cache_read_input_tokens ?? null, cacheWriteTokens: response.usage.cache_creation_input_tokens ?? null },
    };
  },
};

export const openaiApiProvider: TextProvider = {
  name: 'openai_api',
  ownerOnly: false,
  available: async () => (env().OPENAI_API_KEY ? { ok: true, detail: `model: ${env().OPENAI_MODEL}` } : { ok: false, detail: 'OPENAI_API_KEY tanımlı değil' }),
  async complete(prompt) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env().OPENAI_API_KEY}` },
      body: JSON.stringify({ model: env().OPENAI_MODEL, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(env().AI_CLI_TIMEOUT_SECONDS * 1000),
    });
    if (res.status === 429) throw new ProviderLimitError('OpenAI API limiti');
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
    const data: any = await res.json();
    return { text: String(data?.choices?.[0]?.message?.content ?? ''), usage: { model: data?.model ?? env().OPENAI_MODEL, inputTokens: data?.usage?.prompt_tokens ?? null, outputTokens: data?.usage?.completion_tokens ?? null } };
  },
};

export const TEXT_PROVIDERS: Record<string, TextProvider> = {
  cli_claude: cliClaudeProvider,
  cli_codex: cliCodexProvider,
  ollama: ollamaProvider,
  anthropic_api: anthropicApiProvider,
  openai_api: openaiApiProvider,
};

export function resetProviderCache() {
  availabilityCache.clear();
}
