import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default('postgresql://jobtrack:jobtrack@localhost:5432/jobtrack'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  // Uygulamanın dışarıdan erişilen adresi (tünel hostname'i). OAuth dönüşleri ve bildirim linkleri bunu kullanır.
  APP_PUBLIC_URL: z.string().default('http://localhost:8080'),
  JWT_SECRET: z.string().default('dev-only-change-me-dev-only-change-me'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().default(3600),
  REFRESH_TTL_DAYS: z.coerce.number().default(30),
  // 32 bayt, base64. Token ve uygulama parolalarını AES-256-GCM ile şifreler.
  APP_ENCRYPTION_KEY: z.string().default('ZGV2LW9ubHkta2V5LWNoYW5nZS1tZS0zMi1ieXRlcyE='),
  STORAGE_DIR: z.string().default('./storage'),
  MAX_UPLOAD_MB: z.coerce.number().default(15),
  // İlk kayıt davet kodu gerektirmez ve admin olur; sonrakiler davet ister.
  REGISTRATION_MODE: z.enum(['invite', 'open']).default('invite'),
  // Mail
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  FAKE_MAIL_ENABLED: bool.default(true),
  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  TELEGRAM_POLLING: bool.default(true),
  // AI köprüsü
  CLAUDE_CLI_PATH: z.string().default('claude'),
  CLAUDE_CLI_MODEL: z.string().default('sonnet'),
  CODEX_CLI_PATH: z.string().default('codex'),
  AI_CLI_TIMEOUT_SECONDS: z.coerce.number().default(900),
  // Codex CLI argümanları (istem stdin'den verilir). Sürüme göre değişebilir.
  CODEX_CLI_ARGS: z.string().default('exec --skip-git-repo-check -'),
  // Firma raporu için CLI'nin web araştırması (WebSearch/WebFetch) yapmasına izin ver.
  AI_CLI_WEB_RESEARCH: bool.default(true),
  OLLAMA_URL: z.string().optional(),
  OLLAMA_MODEL: z.string().default('qwen2.5:7b-instruct'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-5-mini'),
  // Webhook imza sırrı (mailbox/bildirim sağlayıcı köprüleri için)
  WEBHOOK_SECRET: z.string().default('dev-webhook-secret'),
  // Kaynak erişimi
  HTTP_USER_AGENT: z.string().default('JoblessTurtle/1.1 (+kisisel is arama asistani)'),
  FETCH_TIMEOUT_MS: z.coerce.number().default(15000),
  FETCH_MAX_BYTES: z.coerce.number().default(3_000_000),
  ALLOW_PRIVATE_FETCH: bool.default(false),
  // Worker
  SCHEDULER_ENABLED: bool.default(true),
  DIGEST_HOUR: z.coerce.number().default(9),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

const INSECURE = ['dev-only-change-me-dev-only-change-me', 'ZGV2LW9ubHkta2V5LWNoYW5nZS1tZS0zMi1ieXRlcyE=', 'dev-webhook-secret', 'degistir-en-az-32-karakter-rastgele-deger', 'degistir-webhook-sirri'];

/** Üretimde bilinen varsayılan/örnek sırlarla başlatılmaz (token veya webhook sahteciliğini önler). */
function assertProductionSecrets(e: Env) {
  if (e.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  if (INSECURE.includes(e.JWT_SECRET) || e.JWT_SECRET.length < 32) problems.push('JWT_SECRET');
  if (INSECURE.includes(e.APP_ENCRYPTION_KEY) || Buffer.from(e.APP_ENCRYPTION_KEY, 'base64').length !== 32) problems.push('APP_ENCRYPTION_KEY');
  if (INSECURE.includes(e.WEBHOOK_SECRET) || e.WEBHOOK_SECRET.length < 16) problems.push('WEBHOOK_SECRET');
  if (problems.length) throw new Error(`Güvensiz veya eksik gizli değer(ler): ${problems.join(', ')}. .env dosyasında güçlü değerler üretin (docs/SETUP.md).`);
}

export function env(): Env {
  if (!cached) {
    cached = schema.parse(process.env);
    assertProductionSecrets(cached);
  }
  return cached;
}

export function resetEnvForTests() {
  cached = null;
}
