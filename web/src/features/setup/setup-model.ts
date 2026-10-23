import type { AiSetupStatus, ConnectProvider, ConnectStatus, ExtensionKeyStatus, HomeSetup, LoginSession } from '@/api/types';

export type SetupStepId = 'profile' | 'ai' | 'mail' | 'extension';

export interface SetupStep {
  id: SetupStepId;
  title: string;
  done: boolean;
  /** İsteğe bağlı adım eksik olsa da kurulum tamam sayılır (ana sayfadaki hatırlatmaya girmez). */
  optional: boolean;
  summary: string;
}

export interface SetupInput {
  home: Pick<HomeSetup, 'missing' | 'mailAccount'>;
  ai: AiSetupStatus | undefined;
  /** Uygulama sayfasında eklentinin köprüsü çalışıyorsa sürümü (data-jt-extension). */
  extensionVersion: string | null;
  extensionKey: ExtensionKeyStatus | undefined;
}

export const PROVIDER_NAMES: Record<string, string> = {
  cli_claude: 'Claude (aboneliğin)',
  cli_codex: 'ChatGPT (aboneliğin)',
  anthropic_api: 'Claude API',
  openai_api: 'OpenAI API',
  ollama: 'Yerel model',
};

export const CONNECT_LABELS: Record<ConnectProvider, string> = { cli_claude: 'Claude', cli_codex: 'ChatGPT' };

const PROFILE_PARTS: Record<string, string> = { profile: 'ad ve unvan', cv: 'CV', positions: 'aranan pozisyonlar' };

function profileStep(missing: HomeSetup['missing']): SetupStep {
  const gaps = missing.filter((step) => step in PROFILE_PARTS).map((step) => PROFILE_PARTS[step]);
  return { id: 'profile', title: 'Profil ve CV', done: gaps.length === 0, optional: false, summary: gaps.length ? `Eksik: ${gaps.join(', ')}.` : 'Profil, CV ve aranan pozisyonlar hazır.' };
}

function aiStep(ai: AiSetupStatus | undefined): SetupStep {
  const base = { id: 'ai' as const, title: 'Yapay zekâ bağlantısı', optional: false };
  if (!ai) return { ...base, done: false, summary: 'Kontrol ediliyor…' };
  if (ai.ready) return { ...base, done: true, summary: `Kullanılan: ${ai.usable.map((name) => PROVIDER_NAMES[name] ?? name).join(', ')}.` };
  if (ai.manualAccepted) return { ...base, done: true, summary: 'Kopyala-yapıştır: yapay zekâ işleri istemi Claude ya da ChatGPT sohbetine yapıştırıp cevabı geri yapıştırarak tamamlanır.' };
  return { ...base, done: false, summary: 'Mektup yazımı, firma araştırması ve ilan değerlendirmesi için bir yapay zekâ hesabı bağla ya da kopyala-yapıştır ile devam et.' };
}

function mailStep(mail: HomeSetup['mailAccount']): SetupStep {
  return { id: 'mail', title: 'Gönderim maili', done: !!mail, optional: false, summary: mail ? `${mail.accountEmail} bağlı.` : 'Başvuruların gönderileceği mail hesabı bağlanmadı.' };
}

function extensionStep(version: string | null, key: ExtensionKeyStatus | undefined): SetupStep {
  const base = { id: 'extension' as const, title: 'Tarayıcı eklentisi', optional: true };
  if (version) return { ...base, done: true, summary: `Bu tarayıcıda kurulu ve eşleşmiş (sürüm ${version}).` };
  if (key?.last_used_at) return { ...base, done: true, summary: 'Eklenti eşleşmiş; başka bir tarayıcıda kurulu olabilir.' };
  return { ...base, done: false, summary: 'İsteğe bağlı: Kariyer.net, Indeed gibi bot korumalı sitelerde açtığın aramalardaki ilanları aktarır.' };
}

/** Kurulum ekranındaki yapılacaklar listesi, ekrandaki sırasıyla. */
export function setupSteps(input: SetupInput): SetupStep[] {
  return [profileStep(input.home.missing), aiStep(input.ai), mailStep(input.home.mailAccount), extensionStep(input.extensionVersion, input.extensionKey)];
}

/** Ana sayfadaki hatırlatmaya giren adımlar: zorunlu olup tamamlanmamış olanlar. Yapay zekâ durumu yüklenmeden sayılmaz. */
export function pendingSteps(steps: SetupStep[], aiLoaded: boolean): SetupStep[] {
  return steps.filter((step) => !step.done && !step.optional && (step.id !== 'ai' || aiLoaded));
}

/** Giriş süreci kullanıcının adımını bekliyor; ekran bu sürede kısa aralıkla yenilenir. */
export function loginInProgress(login: LoginSession | null | undefined): boolean {
  return !!login && (login.phase === 'starting' || login.phase === 'waiting' || login.phase === 'verifying');
}

export function anyLoginInProgress(connections: ConnectStatus[] | null | undefined): boolean {
  return (connections ?? []).some((c) => loginInProgress(c.login));
}

/** Bağlantı kartının tek satırlık durumu. */
export function connectionSummary(connection: ConnectStatus): string {
  if (!connection.installed) return 'Bu sunucuda kurulu değil.';
  if (connection.connected) return [connection.account, connection.plan].filter(Boolean).join(' · ') || 'Bağlı';
  const phase = connection.login?.phase;
  if (phase === 'starting') return 'Giriş başlatılıyor…';
  if (phase === 'waiting') return connection.login?.needsCode ? 'Giriş sayfasındaki kodu bekliyor.' : 'Tarayıcıda onay bekleniyor.';
  if (phase === 'verifying') return 'Kod doğrulanıyor…';
  return 'Bağlı değil.';
}

/** "1.3.0" < "1.4.0": kurulu eklenti indirilebilir paketten eskiyse true. */
export function extensionOutdated(installed: string | null, latest: string | null): boolean {
  if (!installed || !latest) return false;
  const a = installed.split('.').map(Number);
  const b = latest.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}
