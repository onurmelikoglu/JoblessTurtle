import { useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { api, errorText } from '@/api/client';
import type { AiTaskDetail } from '@/api/types';
import { Button, LinkButton } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { LoadingBlock } from '@/ui/feedback';
import { Field, Textarea } from '@/ui/fields';
import { toast } from '@/ui/toast';

const MIN_ANSWER_LENGTH = 2;
const WAITING_STATUS = 'awaiting_user';

/** Otomatik AI bağlı değilken: istem sohbete kopyalanır, cevap buraya yapıştırılır. */
export function AiTaskDialog({ taskId, onClose }: { taskId: string; onClose: (done: boolean) => void }) {
  const task = useQuery({ queryKey: ['ai-task', taskId], queryFn: () => api.get<AiTaskDetail>(`/v1/ai/tasks/${taskId}`) });
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const t = task.data;

  const finish = async (request: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await request();
      onClose(true);
    } catch (error) {
      toast.error(errorText(error));
      setBusy(false);
    }
  };

  const copyPrompt = async () => {
    if (!t) return;
    await navigator.clipboard.writeText(t.prompt).then(
      () => toast.success('İstem kopyalandı'),
      () => toast.error('Panoya kopyalanamadı'),
    );
  };

  const settled = !!t && t.status !== WAITING_STATUS;
  return (
    <Dialog
      open
      onClose={() => onClose(false)}
      locked={busy}
      title={t?.kindLabel ?? 'AI görevi'}
      footer={
        settled ? (
          <Button onClick={() => onClose(false)}>Kapat</Button>
        ) : (
        <>
          <Button variant="ghost" disabled={busy} onClick={() => onClose(false)}>
            Sonra
          </Button>
          <Button variant="outline" disabled={busy || !t} onClick={() => finish(() => api.post(`/v1/ai/tasks/${taskId}/template`))}>
            AI olmadan devam et
          </Button>
          <Button variant="primary" loading={busy} disabled={!t || answer.trim().length < MIN_ANSWER_LENGTH} onClick={() => finish(() => api.post(`/v1/ai/tasks/${taskId}/submit`, { text: answer }))}>
            Gönder
          </Button>
        </>
        )
      }
    >
      {task.isError ? (
        <p role="alert" className="text-sm text-bad">
          {errorText(task.error)}
        </p>
      ) : !t ? (
        <LoadingBlock />
      ) : settled ? (
        <p className="text-sm text-ink-soft">Bu görev artık seni beklemiyor; {t.status === 'succeeded' ? 'cevabı alınmış' : 'kapanmış'}. Yapılacak bir şey yok.</p>
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          <p>1. İstemi kopyala ve Claude ya da ChatGPT sohbetine yapıştır.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="tonal" icon={<Copy className="size-4" aria-hidden />} onClick={copyPrompt}>
              İstemi kopyala
            </Button>
            <LinkButton href={t.chatLinks.claude ?? 'https://claude.ai/new'} icon={<ExternalLink className="size-4" aria-hidden />}>
              Claude
            </LinkButton>
            <LinkButton href={t.chatLinks.chatgpt ?? 'https://chatgpt.com/'} icon={<ExternalLink className="size-4" aria-hidden />}>
              ChatGPT
            </LinkButton>
          </div>
          <Field label="2. Gelen cevabın tamamını buraya yapıştır">{(props) => <Textarea {...props} rows={8} value={answer} onChange={(e) => setAnswer(e.target.value)} />}</Field>
        </div>
      )}
    </Dialog>
  );
}
