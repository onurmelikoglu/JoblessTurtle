import { useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Check, X } from 'lucide-react';
import { useState } from 'react';
import { homeApi, type PipelineStageName } from '@/api/home';
import { useAction } from '@/api/queries';
import type { HomeApplicationDetail, InterviewItem } from '@/api/types';
import { fmtDateTime } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Field, Input, Select } from '@/ui/fields';
import { INTERVIEW_KIND_TEXT, INTERVIEW_STATUS_TEXT, localInputToIso, STAGE_OPTIONS } from './pipeline-model';
import { type InterviewActionsApi, useInterviewActions } from './use-interview-actions';

export function InterviewActions({ interview: i, busy, update, download }: { interview: InterviewItem } & InterviewActionsApi) {
  if (i.status === 'proposed') {
    return (
      <span className="flex flex-wrap gap-1">
        <Button size="sm" variant="tonal" disabled={busy} icon={<Check className="size-3.5" aria-hidden />} onClick={() => void update(i, { status: 'scheduled' }, 'Mülâkat takvime alındı')}>
          Onayla
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} icon={<X className="size-3.5" aria-hidden />} onClick={() => void update(i, { status: 'cancelled' }, 'Öneri kaldırıldı')}>
          Yanlış
        </Button>
      </span>
    );
  }
  if (i.status !== 'scheduled') return null;
  return (
    <span className="flex flex-wrap gap-1">
      <Button size="sm" variant="ghost" disabled={busy} icon={<CalendarPlus className="size-3.5" aria-hidden />} onClick={() => void download(i)}>
        Takvime ekle
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void update(i, { status: 'done' }, 'Mülâkat yapıldı olarak işaretlendi')}>
        Yapıldı
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void update(i, { status: 'cancelled' }, 'Mülâkat iptal edildi')}>
        İptal
      </Button>
    </span>
  );
}

/** Başvurunun süreci: aşamalar ve mülâkatlar zaman sırasıyla; yeni aşama ve mülâkat eklenir. */
export function ApplicationPipeline({ d }: { d: HomeApplicationDetail }) {
  const client = useQueryClient();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['application', d.id] });
    void client.invalidateQueries({ queryKey: ['home', 'interviews'] });
  };
  const { busy, run } = useAction();
  const interviewActions = useInterviewActions(refresh);
  const [stage, setStage] = useState<{ stage: PipelineStageName; note: string }>({ stage: 'interview', note: '' });
  const [interview, setInterview] = useState({ startsAt: '', kind: 'video' as InterviewItem['kind'], durationMin: 60, where: '', notes: '' });
  const startsAt = localInputToIso(interview.startsAt);

  const addStage = () => run(() => homeApi.addStage(d.id, { stage: stage.stage, note: stage.note || null }), { success: 'Aşama eklendi' }).then(() => (setStage({ ...stage, note: '' }), refresh()));
  const addInterview = () =>
    startsAt &&
    run(
      () =>
        homeApi.addInterview(d.id, {
          startsAt,
          kind: interview.kind,
          durationMin: interview.durationMin,
          link: interview.kind === 'video' ? interview.where || null : null,
          location: interview.kind === 'onsite' ? interview.where || null : null,
          notes: interview.notes || null,
        }),
      { success: 'Mülâkat eklendi; bir gün ve bir saat kala hatırlatılır' },
    ).then(() => (setInterview({ ...interview, startsAt: '', where: '', notes: '' }), refresh()));

  const events = [
    { key: 'sent', at: d.sentAt, node: <span className="font-medium">Başvuruldu</span> },
    ...d.stages.map((s) => ({
      key: s.id,
      at: s.at,
      node: (
        <span>
          <span className="font-medium">{s.label}</span>
          {s.source === 'inbox' && <span className="text-ink-soft"> · gelen mailden</span>}
          {s.note && <span className="block text-ink-soft">{s.note}</span>}
        </span>
      ),
    })),
    ...d.interviews.map((i) => ({
      key: i.id,
      at: i.startsAt,
      node: (
        <span className="flex flex-col gap-1">
          <span>
            <span className="font-medium">Mülâkat · {INTERVIEW_KIND_TEXT[i.kind]}</span> <Badge tone={i.status === 'proposed' ? 'warn' : i.status === 'scheduled' ? 'info' : 'neutral'}>{INTERVIEW_STATUS_TEXT[i.status]}</Badge>
          </span>
          {(i.link || i.location) && <span className="break-all text-ink-soft">{i.link ?? i.location}</span>}
          {i.notes && <span className="text-ink-soft">{i.notes}</span>}
          <InterviewActions interview={i} {...interviewActions} />
        </span>
      ),
    })),
  ].sort((a, b) => (a.at < b.at ? -1 : 1));

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">Süreç</h3>
      <ol className="flex flex-col gap-2 border-l border-line pl-4">
        {events.map((e) => (
          <li key={e.key} className="relative text-sm">
            <span className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-brand" aria-hidden />
            <span className="block text-xs text-ink-soft">{fmtDateTime(e.at)}</span>
            {e.node}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line p-3">
        <Field label="Aşama" className="w-40">
          {(props) => (
            <Select {...props} value={stage.stage} onChange={(e) => setStage({ ...stage, stage: e.target.value as PipelineStageName })}>
              {STAGE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Not" className="min-w-40 flex-1">
          {(props) => <Input {...props} value={stage.note} maxLength={1000} placeholder="İsteğe bağlı" onChange={(e) => setStage({ ...stage, note: e.target.value })} />}
        </Field>
        <Button variant="outline" disabled={busy} onClick={() => void addStage()}>
          Aşama ekle
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line p-3">
        <Field label="Mülâkat zamanı" className="w-52">
          {(props) => <Input {...props} type="datetime-local" value={interview.startsAt} onChange={(e) => setInterview({ ...interview, startsAt: e.target.value })} />}
        </Field>
        <Field label="Şekli" className="w-36">
          {(props) => (
            <Select {...props} value={interview.kind} onChange={(e) => setInterview({ ...interview, kind: e.target.value as InterviewItem['kind'] })}>
              {(Object.keys(INTERVIEW_KIND_TEXT) as InterviewItem['kind'][]).map((k) => (
                <option key={k} value={k}>
                  {INTERVIEW_KIND_TEXT[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Süre (dk)" className="w-24">
          {(props) => <Input {...props} type="number" min={5} max={480} value={interview.durationMin} onChange={(e) => setInterview({ ...interview, durationMin: Number(e.target.value) || 60 })} />}
        </Field>
        {interview.kind !== 'phone' && (
          <Field label={interview.kind === 'video' ? 'Bağlantı' : 'Adres'} className="min-w-48 flex-1">
            {(props) => <Input {...props} value={interview.where} onChange={(e) => setInterview({ ...interview, where: e.target.value })} />}
          </Field>
        )}
        <Button variant="outline" disabled={busy || !startsAt} icon={<CalendarPlus className="size-4" aria-hidden />} onClick={() => void addInterview()}>
          Mülâkat ekle
        </Button>
      </div>
    </section>
  );
}
