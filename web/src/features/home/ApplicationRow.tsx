import { EllipsisVertical, ExternalLink } from 'lucide-react';
import type { Outcome } from '@/api/home';
import type { HomeApplication } from '@/api/types';
import { fmtDateTime } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { IconButton, LinkButton } from '@/ui/Button';
import { Checkbox } from '@/ui/fields';
import { Menu } from '@/ui/Menu';
import type { Tone } from '@/ui/tones';
import { BUCKET_INFO, bucketOf, INBOX_GROUP_TONE, RESENDABLE_STATES } from './model';

const MAX_CHANNEL_BUTTONS = 2;
const FAILED_NOTE_STATES = new Set(['blocked', 'failed_confirmed', 'cancelled', 'bounced']);
const OUTCOME_CHIP: Record<string, { label: string; tone: Tone }> = {
  interview: { label: 'Görüşme', tone: 'good' },
  offer: { label: 'Teklif', tone: 'good' },
  rejection: { label: 'Olumsuz', tone: 'bad' },
};
const STATE_CHIP: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Sırada', tone: 'warn' },
  sending: { label: 'Sırada', tone: 'warn' },
  replied: { label: 'Yanıt geldi', tone: 'good' },
  submission_unknown: { label: 'Kontrol ediliyor', tone: 'warn' },
  bounced: { label: 'İletilemedi', tone: 'bad' },
  failed_confirmed: { label: 'Gönderilemedi', tone: 'bad' },
  blocked: { label: 'Gönderilemedi', tone: 'bad' },
};

function stateChip(a: HomeApplication): { label: string; tone: Tone } {
  const formDefault = a.viaForm && (a.outcome === null || a.outcome === 'other');
  if (a.outcome && !formDefault) return OUTCOME_CHIP[a.outcome] ?? { label: 'Yanıt yok', tone: 'neutral' };
  if (formDefault) return { label: 'Formla başvuruldu', tone: 'info' };
  if (a.retried) return BUCKET_INFO.resent;
  if (a.delivery && a.delivery.group !== 'pending') return { label: a.delivery.label, tone: INBOX_GROUP_TONE[a.delivery.group] ?? 'neutral' };
  if (a.replyCount > 0) return { label: 'Yanıt geldi', tone: 'good' };
  if (a.state === 'provider_accepted') return { label: a.retryOfId ? 'Tekrar gönderildi' : 'Gönderildi', tone: 'info' };
  return STATE_CHIP[a.state] ?? { label: a.state, tone: 'neutral' };
}

function attemptNote(a: HomeApplication): { text: string; tone: 'warn' | 'bad' } | null {
  if (a.state === 'queued') {
    const text = [a.scheduledAt && `Planlanan gönderim: ${fmtDateTime(a.scheduledAt)}`, a.reasonLabel].filter(Boolean).join(' · ');
    return text ? { text, tone: 'warn' } : null;
  }
  return FAILED_NOTE_STATES.has(a.state) && a.reasonLabel ? { text: `Neden: ${a.reasonLabel}`, tone: 'bad' } : null;
}

/** Firma başka kanal istediyse ya da ilanın formu varsa ilgili bağlantılar satırda buton olur. */
function channelLinks(a: HomeApplication) {
  if (a.viaForm) return [];
  const redirected = bucketOf(a) === 'redirect';
  return a.links.filter((l) => l.kind === 'reply' || (l.kind === 'careers' ? redirected : l.kind !== 'website')).slice(0, MAX_CHANNEL_BUTTONS);
}

export interface ApplicationRowActions {
  onOpen: (application: HomeApplication) => void;
  onToggle: (id: string) => void;
  onRetry: (application: HomeApplication) => void;
  onResend: (application: HomeApplication) => void;
  onUndo: (application: HomeApplication) => void;
  onOutcome: (application: HomeApplication, outcome: Outcome) => void;
  onRemove: (application: HomeApplication) => void;
}

interface ApplicationRowProps extends ApplicationRowActions {
  application: HomeApplication;
  selected: boolean;
}

export function ApplicationRow({ application: a, selected, ...actions }: ApplicationRowProps) {
  const chip = stateChip(a);
  const note = attemptNote(a);
  const name = `${a.company}${a.title ? ` · ${a.title}` : ''}`;
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
      <Checkbox className="mt-0.5" checked={selected} onChange={() => actions.onToggle(a.id)} aria-label={`${name} seç`} />
      <button type="button" onClick={() => actions.onOpen(a)} className="min-w-0 flex-1 basis-56 rounded text-left hover:[&>span:first-child]:underline">
        <span className="block font-medium break-words">{name}</span>
        <span className="block text-sm break-words text-ink-soft">
          {fmtDateTime(a.sentAt)}
          {a.toEmail ? ` · ${a.toEmail}` : ''}
        </span>
        {note && <span className={note.tone === 'bad' ? 'block text-sm text-bad' : 'block text-sm text-warn'}>{note.text}</span>}
      </button>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {channelLinks(a).map((link) => (
          <LinkButton key={link.url} href={link.url} size="sm" variant="outline" icon={<ExternalLink className="size-3.5" aria-hidden />}>
            {link.label}
          </LinkButton>
        ))}
        <Badge tone={chip.tone}>{chip.label}</Badge>
        <Menu
          trigger={
            <IconButton label={`${name} için işlemler`} size="sm">
              <EllipsisVertical className="size-4" aria-hidden />
            </IconButton>
          }
          items={[
            a.state === 'queued' && { label: 'Şimdi tekrar dene', onSelect: () => actions.onRetry(a) },
            RESENDABLE_STATES.has(a.state) && !a.viaForm && { label: 'Düzenle ve tekrar gönder', onSelect: () => actions.onResend(a) },
            a.viaForm && { label: 'Başvurdum işaretini geri al', onSelect: () => actions.onUndo(a) },
            { heading: 'Sonucu işaretle' },
            { label: 'Görüşmeye çağrıldım', onSelect: () => actions.onOutcome(a, 'interview') },
            { label: 'Teklif aldım', onSelect: () => actions.onOutcome(a, 'offer') },
            { label: 'Olumsuz döndüler', onSelect: () => actions.onOutcome(a, 'rejection') },
            { label: 'Yanıt gelmedi', onSelect: () => actions.onOutcome(a, 'no_response') },
            'separator',
            { label: a.state === 'queued' ? 'Sil (gönderimi iptal et)' : 'Listeden sil', onSelect: () => actions.onRemove(a), danger: true },
          ]}
        />
      </div>
    </li>
  );
}
