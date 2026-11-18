import { useQuery } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { homeApi } from '@/api/home';
import { POLL_MS } from '@/api/queries';
import { fmtUntil } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { Panel } from '@/ui/Panel';
import { InterviewActions } from './ApplicationPipeline';
import { useInterviewActions } from './use-interview-actions';
import { INTERVIEW_KIND_TEXT } from './pipeline-model';

/** Yaklaşan ve mailden önerilen mülâkatlar; öneriler onaylanınca hatırlatma kurulur. */
export function InterviewsPanel() {
  const query = useQuery({ queryKey: ['home', 'interviews'], queryFn: homeApi.interviews, refetchInterval: POLL_MS });
  const actions = useInterviewActions(() => void query.refetch());
  const items = query.data ?? [];
  if (!items.length) return null;
  return (
    <Panel>
      <div className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <CalendarClock className="size-4" aria-hidden />
          Mülâkatlar
        </h2>
        <ul className="divide-y divide-line rounded-xl border border-line">
          {items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate text-sm font-medium">
                  {i.company}
                  {i.title ? ` · ${i.title}` : ''}
                </p>
                <p className="text-xs text-ink-soft">
                  {fmtUntil(i.startsAt)} · {INTERVIEW_KIND_TEXT[i.kind]}
                  {i.link || i.location ? ` · ${i.link ?? i.location}` : ''}
                </p>
              </div>
              {i.status === 'proposed' && <Badge tone="warn">Mailden önerildi</Badge>}
              <InterviewActions interview={i} {...actions} />
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
