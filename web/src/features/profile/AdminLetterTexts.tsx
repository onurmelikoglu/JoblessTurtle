import { useState } from 'react';
import { adminApi } from '@/api/admin';
import { useAction } from '@/api/queries';
import { Button } from '@/ui/Button';
import { adminKeys, useAdminRefresh, useLetterStyle } from './admin-queries';
import { Divider, HeadedTextarea, Loaded } from './parts';

interface LetterTextEditorProps {
  title: string;
  description: string;
  placeholder: string;
  initial: string | null;
  saveLabel: string;
  success: string;
  onSave: (text: string) => Promise<unknown>;
}

function LetterTextEditor({ title, description, placeholder, initial, saveLabel, success, onSave }: LetterTextEditorProps) {
  const { busy, run } = useAction();
  const refreshAdmin = useAdminRefresh();
  const [text, setText] = useState(initial ?? '');

  const save = () =>
    run(
      async () => {
        await onSave(text);
        await refreshAdmin(adminKeys.letterStyle);
      },
      { refresh: false, success },
    );

  return (
    <div className="flex flex-col gap-2">
      <HeadedTextarea title={title} description={description} placeholder={placeholder} value={text} onChange={setText} rows={8} />
      <div className="flex justify-end">
        <Button loading={busy} onClick={() => void save()}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

export function AdminLetterTexts() {
  const style = useLetterStyle();
  return (
    <Loaded query={style}>
      {({ guide, text }) => (
        <>
          <LetterTextEditor
            title="Yazı yönergesi"
            description="Kalıplar ve firmaya özel paragraflar bu yönergeye göre yazılır: ton, yapı, kaçınılacak ifadeler, uzunluk."
            placeholder="Başvuru yazısı yönergesi"
            initial={guide}
            saveLabel="Yönergeyi kaydet"
            success="Yönerge kaydedildi; yeni yazılarda kullanılacak"
            onSave={adminApi.saveLetterGuide}
          />
          <Divider />
          <LetterTextEditor
            title="Yazı stili örneği"
            description="Herkesin yazı kalıpları bu örneğin yapısı ve tonuyla, kendi CV'sine göre oluşturulur. Örnekteki kişisel bilgiler kalıplara aktarılmaz."
            placeholder="Örnek bir açık başvuru yazısı yapıştır"
            initial={text}
            saveLabel="Stili kaydet"
            success="Stil örneği kaydedildi; yeni oluşturulan kalıplarda kullanılacak"
            onSave={adminApi.saveLetterStyle}
          />
        </>
      )}
    </Loaded>
  );
}
