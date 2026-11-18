import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Briefcase, ExternalLink, Globe, Mail, MapPin, MessagesSquare, Phone, Send, Sparkles, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { homeApi } from '@/api/home';
import type { DirectoryApplication, DirectoryCompanyDetail, DirectoryJob, DirectoryMessage } from '@/api/types';
import { fmtDate, fmtDateTime, hostOf } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { Button, LinkButton } from '@/ui/Button';
import { Segmented } from '@/ui/controls';
import { EmptyState, LoadError, LoadingBlock } from '@/ui/feedback';
import { Notice } from '@/ui/Notice';
import { Panel } from '@/ui/Panel';
import { ApplicationDialog } from '../home/ApplicationDialog';
import { ApplyPreviewDialog } from '../home/ApplyPreviewDialog';
import { applicationStatus, jobStatus, lastApplyText, messageCategory, workModeText } from './directory-model';

type Section = 'ilanlar' | 'basvurular' | 'yazismalar';

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-soft">{label}</dt>
      <dd className="truncate text-base font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function JobRow({ job, onApply }: { job: DirectoryJob; onApply: (opportunityId: string) => void }) {
  const status = jobStatus(job);
  const mode = workModeText(job.workMode);
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-line px-4 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium break-words">{job.title}</span>
          <Badge tone={status.tone}>{status.label}</Badge>
          {job.newSinceApply && (
            <Badge tone="warn" icon={<Sparkles className="size-3" aria-hidden />}>
              Başvurundan sonra {job.reopenedAt && job.reopenedAt > job.firstSeenAt ? 'yeniden açıldı' : 'açıldı'}
            </Badge>
          )}
          {job.applied && <Badge tone="info">Başvuruldu</Badge>}
        </div>
        <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-soft">
          {job.location && <span>{job.location}</span>}
          {mode && <span>{mode}</span>}
          <span>İlk görülme {fmtDate(job.firstSeenAt)}</span>
          {job.reopenedAt && <span>Yeniden açıldı {fmtDate(job.reopenedAt)}</span>}
          {job.closedAt && job.status === 'closed' && <span>Kapandı {fmtDate(job.closedAt)}</span>}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        {job.url && (
          <LinkButton href={job.url} size="sm" variant="ghost" icon={<ExternalLink className="size-4" aria-hidden />}>
            İlan
          </LinkButton>
        )}
        {job.opportunityId && !job.applied && (
          <Button size="sm" variant="tonal" icon={<Send className="size-4" aria-hidden />} onClick={() => onApply(job.opportunityId!)}>
            Başvur
          </Button>
        )}
      </div>
    </li>
  );
}

function ApplicationItem({ application, onOpen }: { application: DirectoryApplication; onOpen: () => void }) {
  const status = applicationStatus(application);
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full flex-col gap-1 rounded-xl border border-line px-4 py-3 text-left hover:bg-sunken">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{application.title ?? 'Firmaya genel başvuru'}</span>
          <Badge tone={status.tone}>{status.label}</Badge>
          {application.replyCount > 0 && <span className="text-xs text-ink-soft">{application.replyCount} yanıt</span>}
        </div>
        <p className="text-xs text-ink-soft">
          {fmtDateTime(application.sentAt)}
          {application.toEmail ? ` · ${application.toEmail}` : ''}
          {application.subject ? ` · ${application.subject}` : ''}
        </p>
      </button>
    </li>
  );
}

function MessageItem({ message, onOpen }: { message: DirectoryMessage; onOpen: () => void }) {
  const incoming = message.direction === 'in';
  const category = messageCategory(message.category);
  return (
    <li className="flex gap-3">
      <span className={`mt-1 flex size-7 shrink-0 items-center justify-center rounded-full ${incoming ? 'bg-good-soft text-good' : 'bg-brand-soft text-brand'}`} aria-hidden>
        {incoming ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}
      </span>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 rounded-xl border border-line px-4 py-2.5 text-left hover:bg-sunken">
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
          <span className="font-medium text-ink">{incoming ? (message.from ?? 'Gelen mail') : `Sen → ${message.to ?? '-'}`}</span>
          {category && <Badge tone={message.category === 'rejection' ? 'bad' : message.category === 'interview' ? 'good' : 'neutral'}>{category}</Badge>}
          <span className="ml-auto">{fmtDateTime(message.at)}</span>
        </div>
        {message.subject && <p className="mt-1 text-sm font-medium break-words">{message.subject}</p>}
        {message.snippet && <p className="mt-0.5 line-clamp-2 text-sm text-ink-soft">{message.snippet}</p>}
      </button>
    </li>
  );
}

function Header({ detail }: { detail: DirectoryCompanyDetail }) {
  const { company } = detail;
  const otherNames = [...new Set([...company.aliases, ...company.mergedNames])].filter((n) => n !== company.name);
  return (
    <Panel>
      <div className="flex flex-col gap-3">
        <div>
          <h1 className="text-xl font-semibold break-words">{company.name}</h1>
          {otherNames.length > 0 && <p className="text-xs text-ink-soft">Diğer adları: {otherNames.join(', ')}</p>}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-soft">
          {company.website && (
            <a href={company.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
              <Globe className="size-4" aria-hidden />
              {hostOf(company.website)}
            </a>
          )}
          {company.careersUrl && (
            <a href={company.careersUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
              <Briefcase className="size-4" aria-hidden />
              Kariyer sayfası
            </a>
          )}
          {company.cities.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-4" aria-hidden />
              {company.cities.join(', ')}
            </span>
          )}
          {company.employees && (
            <span className="inline-flex items-center gap-1">
              <Users className="size-4" aria-hidden />
              {company.employees.range} çalışan
            </span>
          )}
          {company.phone && (
            <span className="inline-flex items-center gap-1">
              <Phone className="size-4" aria-hidden />
              {company.phone}
            </span>
          )}
          {company.contacts.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Mail className="size-4" aria-hidden />
              {company.contacts.map((c) => c.email).join(', ')}
            </span>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-3 sm:grid-cols-4">
          <Stat label="Son başvuru" value={company.lastAppliedAt ? fmtDate(company.lastAppliedAt) : 'Yok'} />
          <Stat label="Başvuru" value={company.applications} />
          <Stat label="Yanıt" value={company.replies} />
          <Stat label="Açık ilan" value={`${company.openJobs} / ${company.totalJobs}`} />
        </dl>
      </div>
    </Panel>
  );
}

/** Tek firmanın ilanları, başvuruları ve yazışmaları; başvurudan sonra açılan ilanlar öne çıkar. */
export function CompanyDetailPage() {
  const { id = '' } = useParams();
  const client = useQueryClient();
  const detail = useQuery({ queryKey: ['home', 'directory', id], queryFn: () => homeApi.directoryCompany(id), enabled: !!id });
  const [section, setSection] = useState<Section>('ilanlar');
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const [applyId, setApplyId] = useState<string | null>(null);
  const d = detail.data;

  const back = (
    <Link to="/sirketler" className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
      <ArrowLeft className="size-4" aria-hidden />
      Şirketler
    </Link>
  );
  if (detail.isError) return <div className="flex flex-col gap-4">{back}<LoadError label="Firma" onRetry={() => void detail.refetch()} /></div>;
  if (!d) return <LoadingBlock label="Firma yükleniyor…" />;

  const applied = lastApplyText(d.company.lastAppliedAt);
  const newJobs = d.jobs.filter((j) => j.newSinceApply);
  return (
    <div className="flex flex-col gap-4">
      {back}
      <Header detail={d} />
      {newJobs.length > 0 && (
        <Notice tone="warn" icon={<Sparkles className="size-5 shrink-0" aria-hidden />}>
          {applied}; o tarihten sonra {newJobs.length} ilan açıldı ya da yeniden açıldı: {newJobs.map((j) => j.title).join(', ')}.
        </Notice>
      )}
      <Segmented<Section>
        label="Firma ayrıntısı"
        value={section}
        onChange={setSection}
        options={[
          { value: 'ilanlar', label: `İlanlar (${d.jobs.length})`, icon: <Briefcase className="size-4" aria-hidden /> },
          { value: 'basvurular', label: `Başvurular (${d.applications.length})`, icon: <Send className="size-4" aria-hidden /> },
          { value: 'yazismalar', label: `Yazışmalar (${d.messages.length})`, icon: <MessagesSquare className="size-4" aria-hidden /> },
        ]}
      />
      {section === 'ilanlar' &&
        (d.jobs.length ? (
          <ul className="flex flex-col gap-2">
            {d.jobs.map((job) => (
              <JobRow key={job.id} job={job} onApply={setApplyId} />
            ))}
          </ul>
        ) : (
          <EmptyState icon={<Briefcase aria-hidden />}>Bu firmanın kayıtlı ilanı yok.</EmptyState>
        ))}
      {section === 'basvurular' &&
        (d.applications.length ? (
          <ul className="flex flex-col gap-2">
            {d.applications.map((a) => (
              <ApplicationItem key={a.id} application={a} onOpen={() => setApplicationId(a.id)} />
            ))}
          </ul>
        ) : (
          <EmptyState icon={<Send aria-hidden />}>Bu firmaya henüz başvurmadın.</EmptyState>
        ))}
      {section === 'yazismalar' &&
        (d.messages.length ? (
          <ul className="flex flex-col gap-2">
            {d.messages.map((m) => (
              <MessageItem key={m.id} message={m} onOpen={() => m.attemptId && setApplicationId(m.attemptId)} />
            ))}
          </ul>
        ) : (
          <EmptyState icon={<MessagesSquare aria-hidden />}>Bu firmayla yazışma yok.</EmptyState>
        ))}
      {applicationId && <ApplicationDialog id={applicationId} onClose={() => setApplicationId(null)} />}
      {applyId && (
        <ApplyPreviewDialog
          opportunityId={applyId}
          onClose={() => {
            setApplyId(null);
            void client.invalidateQueries({ queryKey: ['home'] });
          }}
        />
      )}
    </div>
  );
}
