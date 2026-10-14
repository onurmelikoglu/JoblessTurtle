import { isTokenStorageKey, readStoredTokens, storeTokens, subjectOf, type Tokens } from './tokens';

const API_BASE = '/api';
const REQUEST_TIMEOUT_MS = 90_000;
const GATEWAY_DOWN = new Set([502, 503, 504]);

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isConflict() {
    return this.status === 409;
  }

  /** Kullanıcıya gösterilecek metin; sunucu ayrıntı listesi verdiyse madde madde eklenir. */
  get display() {
    return Array.isArray(this.details) && this.details.length ? `${this.message}\n• ${this.details.join('\n• ')}` : this.message;
  }
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.display;
  if (error instanceof Error) return error.message;
  return String(error);
}

type Query = Record<string, string | number | boolean | null | undefined>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  as?: 'json' | 'blob';
}

type Listener = () => void;

let tokens: Tokens | null = readStoredTokens();
let refreshing: Promise<boolean> | null = null;
let offline = false;
let onUnauthorized: (() => void) | null = null;
const offlineListeners = new Set<Listener>();

function setOffline(next: boolean) {
  if (offline === next) return;
  offline = next;
  offlineListeners.forEach((listener) => listener());
}

/**
 * Başka bir sekme oturumu değiştirdiğinde: aynı kullanıcının yenilenen anahtarları sessizce alınır.
 * Çıkış yapıldıysa ya da başka bir kullanıcı girdiyse sayfa baştan yüklenir; aksi halde açık formlar
 * önceki kullanıcının verisini yeni hesaba yazabilirdi.
 */
function syncWithOtherTab() {
  const stored = readStoredTokens();
  if (stored?.refreshToken === tokens?.refreshToken) return;
  const sameUser = !!stored && !!tokens && subjectOf(stored.accessToken) !== null && subjectOf(stored.accessToken) === subjectOf(tokens.accessToken);
  if (sameUser) tokens = stored;
  else window.location.reload();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (isTokenStorageKey(event.key)) syncWithOtherTab();
  });
}

function urlFor(path: string, query?: Query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  }
  const suffix = params.size ? `?${params}` : '';
  return `${API_BASE}${path}${suffix}`;
}

async function send(method: string, path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (tokens && !path.includes('/auth/')) headers.Authorization = `Bearer ${tokens.accessToken}`;
  let body: BodyInit | undefined;
  if (options.form) body = options.form;
  else if (method !== 'GET' && method !== 'DELETE') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body ?? {});
  }
  try {
    const response = await fetch(urlFor(path, options.query), { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (GATEWAY_DOWN.has(response.status)) throw new TypeError('gateway');
    setOffline(false);
    return response;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new ApiError(0, 'TIMEOUT', 'Sunucu yanıt vermedi; işlem tamamlanmamış olabilir.');
    setOffline(true);
    throw new ApiError(0, 'OFFLINE', 'Sunucuya ulaşılamıyor. Bağlantı yok ya da sunucu kapalı; gönderim yapılmadı.');
  }
}

async function refreshTokens(): Promise<boolean> {
  const stored = readStoredTokens();
  if (stored && tokens && stored.refreshToken !== tokens.refreshToken) {
    tokens = stored;
    return true;
  }
  if (!tokens) return false;
  try {
    const response = await send('POST', '/v1/auth/refresh', { body: { refreshToken: tokens.refreshToken } });
    if (!response.ok) return false;
    api.setTokens((await response.json()) as Tokens);
    return true;
  } catch {
    return false;
  }
}

async function failure(response: Response): Promise<ApiError> {
  const data: unknown = await response.json().catch(() => null);
  const error = (data as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
  if (error) return new ApiError(response.status, String(error.code), String(error.message), error.details);
  return new ApiError(response.status, `HTTP_${response.status}`, `İstek başarısız (${response.status})`);
}

async function request<T>(method: string, path: string, options: RequestOptions = {}, retried = false): Promise<T> {
  const response = await send(method, path, options);
  if (response.status === 401 && !retried && tokens && !path.includes('/auth/')) {
    refreshing ??= refreshTokens().finally(() => {
      refreshing = null;
    });
    if (await refreshing) return request<T>(method, path, options, true);
  }
  if (response.status === 401 && !path.includes('/auth/')) onUnauthorized?.();
  if (!response.ok) throw await failure(response);
  if (options.as === 'blob') return (await response.blob()) as T;
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, { query }),
  post: <T = unknown>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>('POST', path, { body, headers }),
  put: <T = unknown>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  patch: <T = unknown>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  delete: <T = unknown>(path: string, query?: Query) => request<T>('DELETE', path, { query }),
  blob: (path: string, query?: Query) => request<Blob>('GET', path, { query, as: 'blob' }),

  upload<T = unknown>(path: string, file: File, fields: Record<string, string> = {}) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.set('file', file, file.name);
    return request<T>('POST', path, { form });
  },

  hasSession: () => tokens !== null,
  refreshToken: () => tokens?.refreshToken ?? null,

  setTokens(next: Tokens | null) {
    tokens = next ? { accessToken: next.accessToken, refreshToken: next.refreshToken } : null;
    storeTokens(tokens);
  },

  onUnauthorized(handler: (() => void) | null) {
    onUnauthorized = handler;
  },

  isOffline: () => offline,
  subscribeOffline(listener: Listener) {
    offlineListeners.add(listener);
    return () => {
      offlineListeners.delete(listener);
    };
  },
};
