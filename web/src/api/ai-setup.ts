import { api } from './client';
import type { AiSetupStatus, ApiKeyProviderName, ApiKeyStatus, ConnectProvider, ConnectStatus } from './types';

/** Kurulum listesinin yapay zekâ adımı: hesap bağlama (yalnızca yönetici), API anahtarı ve kopyala-yapıştır seçimi. */
export const aiSetupApi = {
  status: () => api.get<AiSetupStatus>('/v1/ai/setup'),
  acceptManual: (accepted: boolean) => api.post<AiSetupStatus>('/v1/ai/setup/manual', { accepted }),
  startLogin: (provider: ConnectProvider) => api.post<ConnectStatus>(`/v1/ai/connect/${provider}/login`),
  submitCode: (provider: ConnectProvider, code: string) => api.post<ConnectStatus>(`/v1/ai/connect/${provider}/code`, { code }),
  cancelLogin: (provider: ConnectProvider) => api.delete<ConnectStatus>(`/v1/ai/connect/${provider}/login`),
  logout: (provider: ConnectProvider) => api.post<ConnectStatus>(`/v1/ai/connect/${provider}/logout`),
  saveApiKey: (provider: ApiKeyProviderName, key: string) => api.put<Record<ApiKeyProviderName, ApiKeyStatus>>(`/v1/ai/api-keys/${provider}`, { key }),
  deleteApiKey: (provider: ApiKeyProviderName) => api.delete<Record<ApiKeyProviderName, ApiKeyStatus>>(`/v1/ai/api-keys/${provider}`),
};
