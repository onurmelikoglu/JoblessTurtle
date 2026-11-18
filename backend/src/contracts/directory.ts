/**
 * Şirketler sayfası (/v1/home/directory): başvurulmuş olanlar dahil tüm firmalar, ilanları, başvuruları ve yazışmaları.
 * Yalnızca tip; web arayüzü de aynı dosyayı içe aktarır.
 */
import type { EmployeeSize } from '../domain/company-size';
import type { IsoDate } from './home';

export interface DirectoryCompany {
  id: string;
  name: string;
  aliases: string[];
  website: string | null;
  cities: string[];
  sectors: string[];
  employees: EmployeeSize | null;
  openJobs: number;
  totalJobs: number;
  /** En son görülen yeni ilanın tarihi. */
  lastJobAt: IsoDate | null;
  applications: number;
  lastAppliedAt: IsoDate | null;
  replies: number;
  lastReplyAt: IsoDate | null;
  /** Son başvurudan sonra açılan ya da yeniden açılan ilan sayısı. */
  newSinceApply: number;
  /** Firmalar sekmesinde başvurulabilecek fırsatı var mı. */
  hasOpportunity: boolean;
  foundAt: IsoDate;
}

export interface DirectoryList {
  companies: DirectoryCompany[];
  totals: { companies: number; applied: number; newSinceApply: number; replied: number };
}

export interface DirectoryJob {
  id: string;
  title: string;
  status: string;
  location: string | null;
  workMode: string;
  firstSeenAt: IsoDate;
  lastSeenAt: IsoDate;
  closedAt: IsoDate | null;
  reopenedAt: IsoDate | null;
  url: string | null;
  /** Son başvurudan sonra açıldı ya da yeniden açıldı. */
  newSinceApply: boolean;
  /** Bu ilana başvuruldu mu. */
  applied: boolean;
  /** Firmalar sekmesinde başvurulabilecek fırsat. */
  opportunityId: string | null;
}

export interface DirectoryApplication {
  id: string;
  title: string | null;
  state: string;
  stage: string | null;
  outcome: string | null;
  sentAt: IsoDate;
  toEmail: string | null;
  subject: string | null;
  replyCount: number;
}

export type DirectoryMessageDirection = 'out' | 'in';

export interface DirectoryMessage {
  id: string;
  attemptId: string;
  direction: DirectoryMessageDirection;
  at: IsoDate;
  from: string | null;
  to: string | null;
  subject: string | null;
  snippet: string | null;
  /** Gelen mailin türü (yanıt, ret, mülâkat…); giden için null. */
  category: string | null;
}

export interface DirectoryCompanyDetail {
  company: DirectoryCompany & {
    careersUrl: string | null;
    phone: string | null;
    workPolicy: string | null;
    offices: { label: string | null; city: string | null; district: string | null; address: string | null }[];
    contacts: { email: string; kind: string }[];
    /** Bu firmaya yönlenen (birleştirilmiş) eski kayıt adları. */
    mergedNames: string[];
  };
  jobs: DirectoryJob[];
  applications: DirectoryApplication[];
  messages: DirectoryMessage[];
}
