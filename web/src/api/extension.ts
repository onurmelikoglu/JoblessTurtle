import { api } from './client';
import type { ExtensionKeyCreated, ExtensionKeyStatus, ExtensionSearchesResponse } from './types';

/** Tarayıcı eklentisi: kullanıcının kendi anahtarı ve profilinden çıkan arama adresleri. */
export const extensionApi = {
  keyStatus: () => api.get<ExtensionKeyStatus>('/v1/scrapers/extension/key'),
  createKey: () => api.post<ExtensionKeyCreated>('/v1/scrapers/extension/key'),
  revokeKey: () => api.delete('/v1/scrapers/extension/key'),
  searches: () => api.get<ExtensionSearchesResponse>('/v1/scrapers/extension/searches'),
};
