import { Sparkles } from 'lucide-react';
import { useId, useState } from 'react';
import { homeApi } from '@/api/home';
import { useAction, useLetters } from '@/api/queries';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { InlineBusy } from '@/ui/feedback';
import { Textarea } from '@/ui/fields';
import { LETTER_SOURCE_LABELS } from './constants';
import { Divider, HeadedTextarea, Loaded, Section } from './parts';
import { useLetterRegeneration, type LetterTemplate } from './use-letter-regeneration';

const INTRO =
  'Her kategori için yazı kalıbı bir kez oluşturulur ve tüm firmalarda kullanılır. {firma} firma adıyla; {firma_giris} firmaya özel açılış paragrafıyla (neden ilgilendiğin, pozisyon ya da açık başvuru); {firma_baglanti} ise deneyiminin bu firmada nasıl değer katacağını anlatan paragrafla her firma için otomatik doldurulur. Geri kalanını dilediğin gibi düzenleyebilirsin.';

interface LetterExampleEditorProps {
  initial: string | null;
  saving: boolean;
  locked: boolean;
  onSave: (text: string) => void;
}

function LetterExampleEditor({ initial, saving, locked, onSave }: LetterExampleEditorProps) {
  const [text, setText] = useState(initial ?? '');
  return (
    <div className="flex flex-col gap-2">
      <HeadedTextarea
        title="Kendi örnek yazın (isteğe bağlı)"
        description="Daha önce gönderdiğin bir başvuruyu yapıştır. Kalıplar yapı ve ton olarak ortak şablona uyar; deneyimlerin, projelerin ve vurguların bu örnekten ve CV'nden alınır."
        placeholder="Örnek başvuru yazın"
        value={text}
        onChange={setText}
      />
      <div className="flex justify-end">
        <Button icon={<Sparkles className="size-4" aria-hidden />} loading={saving} disabled={locked} onClick={() => onSave(text)}>
          Kaydet ve kalıpları yeniden oluştur
        </Button>
      </div>
    </div>
  );
}

interface LetterTemplateEditorProps {
  template: LetterTemplate;
  regenerating: boolean;
  onRegenerate: () => void;
}

function LetterTemplateEditor({ template, regenerating, onRegenerate }: LetterTemplateEditorProps) {
  const titleId = useId();
  const { busy, run } = useAction();
  const [draft, setDraft] = useState<{ version: string | null; text: string } | null>(null);
  const created = template.body !== null;
  /** Taslak yalnızca yazıldığı sürüm için geçerlidir; kalıp sunucuda değişince (kayıt, yeniden oluşturma) yeni metin gösterilir. */
  const text = draft && draft.version === template.updatedAt ? draft.text : (template.body ?? '');

  return (
    <li className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2">
        <h3 id={titleId} className="min-w-0 flex-1 text-sm font-semibold">
          {template.label}
        </h3>
        {template.source && <Badge>{LETTER_SOURCE_LABELS[template.source] ?? template.source}</Badge>}
      </div>
      {regenerating ? (
        <div className="py-3">
          <InlineBusy>Claude kalıbı CV'ne göre hazırlıyor…</InlineBusy>
        </div>
      ) : created ? (
        <Textarea aria-labelledby={titleId} rows={10} value={text} onChange={(e) => setDraft({ version: template.updatedAt, text: e.target.value })} className="field-sizing-content max-h-[36rem]" />
      ) : (
        <p className="text-sm text-ink-soft">Henüz oluşturulmadı; bu kategoride ilk "Başvur"da otomatik oluşturulur.</p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" icon={<Sparkles className="size-4" aria-hidden />} disabled={regenerating} onClick={onRegenerate}>
          {created ? 'Yeniden oluştur' : 'Şimdi oluştur'}
        </Button>
        {created && (
          <Button loading={busy} onClick={() => void run(() => homeApi.saveLetter(template.intent, text), { success: 'Kalıp kaydedildi; yeni yazılarda kullanılacak' })}>
            Kaydet
          </Button>
        )}
      </div>
    </li>
  );
}

export function LettersSection() {
  const letters = useLetters();
  const { regenerating, savingExample, regenerate, saveExample } = useLetterRegeneration();

  return (
    <Section title="Başvuru yazısı kalıpları">
      <p className="text-sm text-ink-soft">{INTRO}</p>
      <Loaded query={letters}>
        {(data) => (
          <>
            <LetterExampleEditor initial={data.example} saving={savingExample} locked={regenerating.size > 0} onSave={(text) => void saveExample(text, data.templates)} />
            <Divider />
            <ul className="divide-y divide-line">
              {data.templates.map((template) => (
                <LetterTemplateEditor key={template.intent} template={template} regenerating={regenerating.has(template.intent)} onRegenerate={() => void regenerate(template)} />
              ))}
            </ul>
          </>
        )}
      </Loaded>
    </Section>
  );
}
