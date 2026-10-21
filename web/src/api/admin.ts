import { api } from './client';
import type { AdminUser, AiStatus, AiUsage, Invite, LearningOverview, LetterStyle, ModelSettings, ScraperConfig, ScraperHistoryPage, ScraperRunRequest, ScraperRunResponse, ScraperStatus, ServerSettings } from './types';

export interface PasswordReset {
  email: string;
  temporaryPassword: string;
}

export type AiSettingsPatch = { dailyTaskLimit: number } | { models: ModelSettings };

/** Ayar güncellemesi durumun yalnızca bu iki alanını döndürür; etiketler ve varsayılan modeller için durum yeniden okunur. */
export type AiSettingsResult = Pick<AiStatus, 'settings' | 'providers'>;

export const adminApi = {
  letterStyle: () => api.get<LetterStyle>('/v1/admin/letter-style'),
  saveLetterGuide: (text: string) => api.put<{ text: string }>('/v1/admin/letter-guide', { text }),
  saveLetterStyle: (text: string) => api.put<{ text: string }>('/v1/admin/letter-style', { text }),

  settings: () => api.get<ServerSettings>('/v1/admin/settings'),
  updateSettings: (patch: Partial<ServerSettings>) => api.patch<ServerSettings>('/v1/admin/settings', patch),

  invites: () => api.get<Invite[]>('/v1/invites'),
  createInvite: () => api.post<Invite>('/v1/invites'),

  users: () => api.get<AdminUser[]>('/v1/admin/users'),
  resetPassword: (userId: string) => api.post<PasswordReset>(`/v1/admin/users/${userId}/reset-password`),

  aiStatus: () => api.get<AiStatus>('/v1/ai/status'),
  updateAiSettings: (patch: AiSettingsPatch) => api.patch<AiSettingsResult>('/v1/ai/settings', patch),
  aiUsage: () => api.get<AiUsage>('/v1/admin/ai-usage'),

  learning: () => api.get<LearningOverview>('/v1/admin/learning'),
  trainModels: () => api.post<LearningOverview>('/v1/admin/learning/train'),
  exportLearning: () => api.blob('/v1/admin/learning/export'),

  scraperStatus: () => api.get<ScraperStatus>('/v1/scrapers/status'),
  scraperHistory: (limit = 10) => api.get<ScraperHistoryPage>('/v1/scrapers/history', { limit }),
  scraperConfig: () => api.get<ScraperConfig>('/v1/scrapers/config'),
  saveScraperConfig: (patch: Record<string, unknown>) => api.post<ScraperConfig>('/v1/scrapers/config', patch),
  runScrapers: (body: ScraperRunRequest) => api.post<ScraperRunResponse>('/v1/scrapers/run', body),

  changePassword: (currentPassword: string, newPassword: string) => api.post('/v1/me/password', { currentPassword, newPassword }),
};
