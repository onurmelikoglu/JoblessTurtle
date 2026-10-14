import { Send } from 'lucide-react';
import { useState } from 'react';
import type { HomeApplication } from '@/api/types';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { Checkbox } from '@/ui/fields';

interface RetryQueueDialogProps {
  queued: HomeApplication[];
  onClose: (ids: string[] | null) => void;
}

export function RetryQueueDialog({ queued, onClose }: RetryQueueDialogProps) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(queued.map((a) => a.id)));
  const allChosen = chosen.size === queued.length;
  const toggle = (id: string) => setChosen((current) => new Set(current.has(id) ? [...current].filter((x) => x !== id) : [...current, id]));
  return (
    <Dialog
      open
      onClose={() => onClose(null)}
      title="Bekleyenleri tekrar dene"
      description="İşaretli başvurular hemen sıraya alınır; mailler arasında 30-50 sn beklenir. Göndermek istemediklerinin işaretini kaldır."
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose(null)}>
            Vazgeç
          </Button>
          <Button variant="primary" disabled={chosen.size === 0} icon={<Send className="size-4" aria-hidden />} onClick={() => onClose([...chosen])}>
            Seçilenleri gönder ({chosen.size})
          </Button>
        </>
      }
    >
      <Checkbox checked={allChosen} onChange={() => setChosen(allChosen ? new Set() : new Set(queued.map((a) => a.id)))} label={allChosen ? 'Seçimi kaldır' : 'Tümünü seç'} />
      <ul className="mt-1 divide-y divide-line border-t border-line">
        {queued.map((a) => (
          <li key={a.id} className="py-1.5">
            <Checkbox
              checked={chosen.has(a.id)}
              onChange={() => toggle(a.id)}
              label={
                <span className="min-w-0">
                  <span className="block break-words">
                    {a.company}
                    {a.title ? ` · ${a.title}` : ''}
                  </span>
                  <span className="block text-xs break-words text-ink-soft">{[a.toEmail, a.scheduledAt && `planlanan ${fmtDateTime(a.scheduledAt)}`].filter(Boolean).join(' · ')}</span>
                </span>
              }
            />
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
