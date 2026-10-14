import { Building2, Inbox, Mail, MailWarning, Send, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { errorText } from '@/api/client';
import { useApplications, useCompanies, useHomeState, useInbox, useRefreshHome } from '@/api/queries';
import type { HomeState } from '@/api/types';
import { SetupWizard } from '@/features/setup/SetupWizard';
import { LINK_PARAMS, withoutParams } from '@/notification-links';
import { Button } from '@/ui/Button';
import { Segmented } from '@/ui/controls';
import { LoadingBlock } from '@/ui/feedback';
import { Notice } from '@/ui/Notice';
import { AiTaskDialog } from './AiTaskDialog';
import { ApplicationsTab } from './ApplicationsTab';
import { CompaniesTab } from './CompaniesTab';
import { InboxTab } from './InboxTab';
import { bucketCounts, HOME_TABS, isInboxTodo, type HomeTab } from './model';
import { StatusPanel, type HomeStats } from './StatusPanel';

const TAB_PARAM = 'tab';
const DEFAULT_TAB: HomeTab = 'firmalar';

function Responsive({ short, full }: { short: string; full: string }) {
  return (
    <>
      <span className="sm:hidden">{short}</span>
      <span className="max-sm:hidden">{full}</span>
    </>
  );
}

function CountBadge({ count, urgent = false }: { count: number; urgent?: boolean }) {
  return <span className={urgent ? 'rounded-full bg-alert px-1.5 text-[11px] leading-5 font-semibold text-white tabular-nums' : 'text-ink-faint tabular-nums'}>{count}</span>;
}

function Dashboard({ state }: { state: HomeState }) {
  const [params, setParams] = useSearchParams();
  const requested = params.get(TAB_PARAM);
  const tab: HomeTab = (HOME_TABS as readonly string[]).includes(requested ?? '') ? (requested as HomeTab) : DEFAULT_TAB;
  const companies = useCompanies(true);
  const applications = useApplications(true);
  const inbox = useInbox(true);
  const refreshHome = useRefreshHome();
  const [chosenTaskId, setAiTaskId] = useState<string | null>(null);
  const aiTaskId = chosenTaskId ?? params.get(LINK_PARAMS.aiTask);

  const inboxItems = inbox.data?.items ?? [];
  const inboxTodo = inboxItems.filter(isInboxTodo).length;
  const waiting = state.aiWaiting;
  const stats: HomeStats = {
    companies: companies.data?.totals.companies ?? state.counts.suggestions,
    matchingJobs: companies.data?.totals.matchingJobs ?? 0,
    applications: applications.data?.items.length ?? state.counts.applied,
    replies: applications.data ? bucketCounts(applications.data.items).counts.reply : state.counts.replied,
  };
  const setTab = (next: HomeTab) =>
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next === DEFAULT_TAB) updated.delete(TAB_PARAM);
      else updated.set(TAB_PARAM, next);
      return updated;
    });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="sr-only">Ana sayfa</h1>
      {state.setup.missing.includes('mail') && (
        <Notice
          tone="warn"
          icon={<Mail className="size-5 shrink-0" aria-hidden />}
          action={
            <Link to="/profile" className="font-medium text-brand hover:underline">
              Mail bağla
            </Link>
          }
        >
          Başvuru gönderebilmek için mail hesabını bağla.
        </Notice>
      )}
      {waiting.length > 0 && (
        <Notice
          icon={<Sparkles className="size-5 shrink-0" aria-hidden />}
          action={
            <Button variant="tonal" size="sm" onClick={() => setAiTaskId(waiting[0].id)}>
              Tamamla
            </Button>
          }
        >
          {waiting.length === 1 ? `Bir AI görevi seni bekliyor: ${waiting[0].label}` : `${waiting.length} AI görevi seni bekliyor`}
        </Notice>
      )}
      <StatusPanel state={state} stats={stats} />
      <Segmented
        label="Bölümler"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'firmalar', label: 'Firmalar', icon: <Building2 className="size-4 max-sm:hidden" aria-hidden />, badge: companies.data && <CountBadge count={companies.data.totals.companies} /> },
          { value: 'basvurular', label: <Responsive short="Başvurular" full="Başvurularım" />, icon: <Send className="size-4 max-sm:hidden" aria-hidden />, badge: applications.data && <CountBadge count={applications.data.items.length} /> },
          { value: 'donusler', label: <Responsive short="Dönüşler" full="Mail dönüşleri" />, icon: inboxTodo > 0 ? <MailWarning className="size-4 max-sm:hidden" aria-hidden /> : <Inbox className="size-4 max-sm:hidden" aria-hidden />, badge: inboxTodo > 0 && <CountBadge count={inboxTodo} urgent /> },
        ]}
      />
      <div role="tabpanel">
        {tab === 'firmalar' && <CompaniesTab data={companies.data} state={state} />}
        {tab === 'basvurular' && <ApplicationsTab data={applications.data} inboxItems={inboxItems} inboxTodo={inboxTodo} onOpenInbox={() => setTab('donusler')} />}
        {tab === 'donusler' && <InboxTab inbox={inbox.data} ai={state.ai} />}
      </div>
      {aiTaskId && (
        <AiTaskDialog
          taskId={aiTaskId}
          onClose={(done) => {
            setAiTaskId(null);
            if (params.has(LINK_PARAMS.aiTask)) setParams((current) => withoutParams(current, LINK_PARAMS.aiTask), { replace: true });
            if (done) void refreshHome();
          }}
        />
      )}
    </div>
  );
}

export function HomePage() {
  const state = useHomeState();
  if (state.data) {
    const needsSetup = state.data.setup.missing.some((step) => step !== 'mail');
    return needsSetup ? <SetupWizard state={state.data} /> : <Dashboard state={state.data} />;
  }
  if (state.isError) {
    return (
      <Notice
        tone="error"
        action={
          <Button variant="outline" size="sm" onClick={() => void state.refetch()}>
            Tekrar dene
          </Button>
        }
      >
        {errorText(state.error)}
      </Notice>
    );
  }
  return <LoadingBlock />;
}
