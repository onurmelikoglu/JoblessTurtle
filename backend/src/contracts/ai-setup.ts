/**
 * Kurulum listesinin yapay zekâ adımı ve arayüzden hesap bağlama (/v1/ai/setup, /v1/ai/connect, /v1/ai/api-keys)
 * yanıt sözleşmesi. Web arayüzü bu dosyayı yalnızca tip olarak içe aktarır.
 */
import type { IsoDate } from './wire';

export type ConnectProvider = 'cli_claude' | 'cli_codex';
export type ApiKeyProviderName = 'anthropic_api' | 'openai_api';

/** starting: CLI açılıyor · waiting: kullanıcı tarayıcıda giriş yapıyor · verifying: Claude kodu doğrulanıyor. */
export type LoginPhase = 'starting' | 'waiting' | 'verifying' | 'failed' | 'expired';

export interface LoginSession {
  phase: LoginPhase;
  /** Kullanıcının tarayıcıda açacağı giriş adresi. */
  url: string | null;
  /** ChatGPT cihaz girişinde sayfaya yazılacak tek kullanımlık kod. */
  userCode: string | null;
  /** Claude girişinde, giriş sayfasının sonunda verilen kodun buraya yapıştırılması gerekir. */
  needsCode: boolean;
  message: string | null;
  expiresAt: IsoDate;
}

export interface ConnectStatus {
  provider: ConnectProvider;
  /** CLI bu sunucuda kurulu mu (INSTALL_AI_CLI=true). */
  installed: boolean;
  connected: boolean;
  account: string | null;
  plan: string | null;
  login: LoginSession | null;
}

export interface ApiKeyStatus {
  /** stored: arayüzden girildi · env: .env'deki yedek · null: anahtar yok. */
  source: 'stored' | 'env' | null;
  last4: string | null;
  savedAt: IsoDate | null;
}

export interface AiSetupStatus {
  /** Çalışma alanının sırasındaki gerçek sağlayıcılardan en az biri şu an kullanılabilir. */
  ready: boolean;
  usable: string[];
  /** Gerçek sağlayıcı yerine kopyala-yapıştır köprüsüyle devam etmek seçildi. */
  manualAccepted: boolean;
  /** Kişisel abonelikle çalışan CLI bu çalışma alanında kullanılabilir mi. */
  cliAllowed: boolean;
  /** Hesap bağlama ve API anahtarı yalnızca sunucu yöneticisine açıktır; diğerlerinde aşağıdakiler null döner. */
  canManage: boolean;
  connections: ConnectStatus[] | null;
  apiKeys: Record<ApiKeyProviderName, ApiKeyStatus> | null;
}
