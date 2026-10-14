/**
 * Oturum anahtarları tarayıcı deposunda JSON kodlu tutulur. "flutter." öneki ilk arayüzden kalmadır; değiştirmek
 * açık oturumları düşüreceği için korunur.
 */
const ACCESS_KEY = 'flutter.accessToken';
const REFRESH_KEY = 'flutter.refreshToken';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

function read(key: string): string | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' && parsed ? parsed : null;
  } catch {
    return raw;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
}

export function readStoredTokens(): Tokens | null {
  const accessToken = read(ACCESS_KEY);
  const refreshToken = read(REFRESH_KEY);
  return accessToken && refreshToken ? { accessToken, refreshToken } : null;
}

export function storeTokens(tokens: Tokens | null) {
  write(ACCESS_KEY, tokens?.accessToken ?? null);
  write(REFRESH_KEY, tokens?.refreshToken ?? null);
}

/** Erişim anahtarının (JWT) ait olduğu kullanıcı; çözülemiyorsa null. İmza doğrulanmaz, yalnızca karşılaştırma içindir. */
export function subjectOf(accessToken: string | null | undefined): string | null {
  const payload = accessToken?.split('.')[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    const subject = (claims as { sub?: unknown }).sub;
    return typeof subject === 'string' ? subject : null;
  } catch {
    return null;
  }
}

export function isTokenStorageKey(key: string | null) {
  return key === ACCESS_KEY || key === REFRESH_KEY;
}
