import type { IsoDate } from '@contracts/home';

export type * from '@contracts/home';
export type * from '@contracts/learning';

export interface AuthStatus {
  needsSetup: boolean;
  registrationMode: string;
}

export interface Me {
  user: { id: string; email: string; displayName: string; isAdmin: boolean };
  workspace: { id: string; name: string; automationPaused: boolean };
  telegramLinked: boolean;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: IsoDate | null;
  createdAt: IsoDate;
}

export interface AiTaskDetail {
  id: string;
  kind: string;
  kindLabel: string;
  status: string;
  prompt: string;
  chatLinks: { claude?: string; chatgpt?: string };
}

export type ModelSettings = Record<string, Record<string, string>>;

export interface AiStatus {
  settings: { dailyTaskLimit: number; models?: ModelSettings };
  providers: { name: string; label: string; available: boolean; detail: string }[];
  kindLabels: Record<string, string>;
  defaultModels: ModelSettings;
  cooldowns: Record<string, string | undefined>;
}

export interface AiUsage {
  since: IsoDate;
  cooldowns: Record<string, string | undefined>;
  rows: { kind: string; kindLabel: string; provider: string; model: string | null; count: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; avgSeconds: number }[];
}

export interface ServerSettings {
  shareCliWithInvitees: boolean;
  inviteeDailyLimit: number;
}

export interface LetterStyle {
  text: string | null;
  guide: string | null;
}

export interface Invite {
  id: string;
  code: string;
  usedAt: IsoDate | null;
  expiresAt: IsoDate;
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  lastSeenAt: IsoDate | null;
  aiTasksToday: number;
}

export interface LookupResult {
  status: 'pending' | 'added' | 'exists' | 'not_found' | 'failed';
  lookupId?: string;
  companyId?: string;
  name?: string;
  openRoles?: number;
  reason?: string;
}

export interface MissingEmailsResult {
  queued: number;
  companyIds: string[];
  skippedRecent: number;
  deferred: number;
}

export interface ResendManyResult {
  queued: number;
  results: { attemptId: string; company: string; status: 'queued' | 'skipped'; toEmail?: string; reason?: string }[];
}

export interface SmtpAccountInput {
  accountEmail: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  appPassword: string;
}

export interface ProfileInput {
  displayName: string;
  email?: string | null;
  headline?: string | null;
  portfolioUrl?: string | null;
  signature?: string | null;
  positions?: string[];
  adjacentPositions?: string[];
  cities?: string[];
  allowRemote?: boolean;
  abroadRemote?: boolean;
  abroadRelocation?: boolean;
  abroadRegions?: string[];
}
