import { api } from './client';
import type {
  HomeApplicationDetail,
  HomeApplications,
  HomeCompanies,
  HomeInboxWithAutopilot,
  HomeLetters,
  HomePreview,
  HomePreviewDraft,
  HomeState,
  HomeStateWithPolicy,
  InboxDetail,
  LookupResult,
  MissingEmailsResult,
  ProfileInput,
  ResendManyResult,
  SizeSearchResult,
  SmtpAccountInput,
} from './types';

export type Outcome = 'interview' | 'offer' | 'rejection' | 'no_response';
export type InboxStatus = 'open' | 'resolved' | 'ignored';
export type DocumentType = 'cv' | 'portfolio';
export type DocumentLanguage = 'tr' | 'en';

export interface DraftEdit {
  toEmail: string;
  subject: string;
  body: string;
  documentIds?: string[];
}

export interface ResendInput {
  toEmail: string;
  subject: string;
  body: string;
  documentIds: string[];
}

export const homeApi = {
  state: () => api.get<HomeState>('/v1/home'),
  companies: () => api.get<HomeCompanies>('/v1/home/companies'),
  applications: () => api.get<HomeApplications>('/v1/home/applications'),
  application: (id: string) => api.get<HomeApplicationDetail>(`/v1/home/applications/${id}`),
  inbox: () => api.get<HomeInboxWithAutopilot>('/v1/home/inbox'),
  inboxDetail: (id: string) => api.get<InboxDetail>(`/v1/home/inbox/${id}`),
  letters: () => api.get<HomeLetters>('/v1/home/letters'),
  preview: (opportunityId: string) => api.get<HomePreview>(`/v1/home/preview/${opportunityId}`),

  saveProfile: (input: ProfileInput) => api.put<HomeStateWithPolicy>('/v1/home/profile', input),
  syncPolicy: () => api.post<HomeStateWithPolicy>('/v1/home/sync'),
  setAutoSend: (enabled: boolean) => api.post<HomeState>('/v1/home/auto-apply', { enabled }),
  search: () => api.post('/v1/home/search'),
  stopSearch: () => api.post<HomeState>('/v1/home/search/stop'),
  targetedSearch: (query: string) => api.post<{ queued: boolean }>('/v1/home/search/targeted', { query }),
  setMailLimit: (dailyLimit: number) => api.put<HomeState>('/v1/home/mail-limit', { dailyLimit }),

  prepare: (opportunityIds: string[]) => api.post<{ preparing: number; ready: number }>('/v1/home/prepare', { opportunityIds }),
  redraft: (opportunityId: string) => api.post('/v1/home/redraft', { opportunityId }),
  apply: (opportunityIds: string[]) => api.post<{ queued: number }>('/v1/home/apply', { opportunityIds }),
  markApplied: (opportunityId: string) => api.post('/v1/home/mark-applied', { opportunityId }),
  dismiss: (opportunityId: string) => api.patch(`/v1/opportunities/${opportunityId}`, { status: 'dismissed' }),
  translateDraft: (draftId: string, lang: 'en' | 'tr') => api.post<{ queued: boolean; revision: number }>(`/v1/home/drafts/${draftId}/translate`, { lang }),
  saveDraft: (draft: Pick<HomePreviewDraft, 'id' | 'revision'>, edit: DraftEdit) =>
    api.patch(`/v1/drafts/${draft.id}`, { revision: draft.revision, toEmail: edit.toEmail || null, subject: edit.subject, body: edit.body, ...(edit.documentIds ? { documentIds: edit.documentIds } : {}) }),

  researchCompany: (companyId: string) => api.post(`/v1/home/companies/${companyId}/details`),
  researchMissingEmails: (force: boolean) => api.post<MissingEmailsResult>('/v1/home/companies/missing-emails', { force }),
  researchSizes: () => api.post<SizeSearchResult>('/v1/home/companies/sizes'),
  lookupCompany: (name: string) => api.post<LookupResult>('/v1/home/companies/lookup', { name }),
  lookupStatus: (lookupId: string) => api.get<LookupResult>(`/v1/home/companies/lookup/${lookupId}`),

  recordOutcome: (attemptId: string, outcome: Outcome) => api.post(`/v1/applications/${attemptId}/outcome`, { outcome }),
  removeApplications: (ids: string[]) => api.post<{ removed: number; cancelled: number }>('/v1/home/applications/remove', { ids }),
  retryApplications: (ids?: string[]) => api.post<{ requeued: number }>('/v1/home/applications/retry', ids ? { ids } : {}),
  undoApplied: (attemptId: string) => api.post(`/v1/home/applications/${attemptId}/undo`),
  resend: (attemptId: string, input: ResendInput) => api.post<{ attemptId: string; state: string; toEmail: string }>(`/v1/home/applications/${attemptId}/resend`, input),
  resendMany: (ids: string[]) => api.post<ResendManyResult>('/v1/home/applications/resend', { ids }),

  syncInbox: () => api.post<{ queued: number }>('/v1/home/inbox/sync'),
  setInboxEnabled: (enabled: boolean) => api.put('/v1/home/inbox/settings', { enabled }),
  setInboxStatus: (ids: string[], status: InboxStatus) => api.post('/v1/home/inbox/status', { ids, status }),
  approveAutopilot: (ids: string[]) => api.post<{ queued: number }>('/v1/home/autopilot/approve', { ids }),
  dismissAutopilot: (ids: string[]) => api.post<{ dismissed: number }>('/v1/home/autopilot/dismiss', { ids }),

  saveLetter: (intent: string, body: string) => api.put(`/v1/home/letters/${intent}`, { body }),
  saveLetterExample: (text: string | null) => api.put<{ text: string | null }>('/v1/home/letter-example', { text }),
  regenerateLetter: (intent: string) => api.post(`/v1/home/letters/${intent}/regenerate`),

  uploadDocument: (candidateId: string, type: DocumentType, file: File, language: DocumentLanguage = 'tr') => api.upload('/v1/documents', file, { candidateId, type, language }),
  downloadDocument: (documentId: string) => api.blob(`/v1/documents/${documentId}/download`),
  connectMail: (candidateId: string, input: SmtpAccountInput) => api.post('/v1/mail-accounts/smtp', { candidateId, ...input }),
  deleteMailAccount: (id: string) => api.delete(`/v1/mail-accounts/${id}`),
};
