import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { homeApi } from '@/api/home';
import { POLL_MS, queryKeys } from '@/api/queries';
import { useMe } from '@/auth/session-context';
import { LoadingBlock } from '@/ui/feedback';
import { Notice } from '@/ui/Notice';
import { AboutSection } from './AboutSection';
import { AccountSection } from './AccountSection';
import { AdminSection } from './AdminSection';
import { AiAdminSection } from './AiAdminSection';
import { DocumentsSection } from './DocumentsSection';
import { LearningAdminSection } from './LearningAdminSection';
import { LettersSection } from './LettersSection';
import { MailSection } from './MailSection';
import { QueryError } from './parts';
import { ScrapersAdminSection } from './ScrapersAdminSection';

export function ProfilePage() {
  const me = useMe();
  /** Form bir kez doldurulduğu için önbellekteki eski durumla değil, sayfa açılırken alınan güncel durumla başlanır. */
  const home = useQuery({ queryKey: queryKeys.state, queryFn: homeApi.state, refetchInterval: POLL_MS, refetchOnMount: 'always' });
  const [policyBlocker, setPolicyBlocker] = useState<string | null>(null);
  const setup = home.isFetchedAfterMount ? home.data?.setup : undefined;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Profilim</h1>
      {setup ? (
        <>
          {policyBlocker && (
            <Notice tone="warn" icon={<Info className="size-5 shrink-0" aria-hidden />}>
              {policyBlocker}
            </Notice>
          )}
          <AboutSection setup={setup} onPolicy={setPolicyBlocker} />
          <DocumentsSection setup={setup} onPolicy={setPolicyBlocker} />
          <MailSection setup={setup} onPolicy={setPolicyBlocker} />
          <LettersSection />
          <AccountSection />
          {me.user.isAdmin && (
            <>
              <AiAdminSection />
              <LearningAdminSection />
              <ScrapersAdminSection />
              <AdminSection />
            </>
          )}
        </>
      ) : home.isError ? (
        <QueryError error={home.error} onRetry={() => void home.refetch()} />
      ) : (
        <LoadingBlock />
      )}
    </div>
  );
}
