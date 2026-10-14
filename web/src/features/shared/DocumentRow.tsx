import { CircleCheck, FileText, Upload } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '@/ui/Button';
import { Spinner } from '@/ui/Spinner';
import { DOCUMENT_ACCEPT } from './documents';

interface DocumentRowProps {
  label: string;
  document: { fileName: string; scanState: string } | null;
  uploading: boolean;
  disabled: boolean;
  onPick: (file: File) => void;
}

export function DocumentRow({ label, document, uploading, disabled, onPick }: DocumentRowProps) {
  const input = useRef<HTMLInputElement>(null);
  const status = uploading ? 'Yükleniyor ve güvenlik taramasından geçiriliyor…' : !document ? 'Henüz yüklenmedi' : `${document.fileName}${document.scanState === 'clean' ? '' : ' · taranıyor'}`;
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sunken text-ink-soft">
        {uploading ? <Spinner /> : document ? <CircleCheck className="size-5 text-good" aria-hidden /> : <FileText className="size-5" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="truncate text-sm text-ink-soft">{status}</p>
      </div>
      <input
        ref={input}
        type="file"
        accept={DOCUMENT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onPick(file);
        }}
      />
      <Button variant="outline" size="sm" icon={<Upload className="size-4" aria-hidden />} disabled={disabled || uploading} onClick={() => input.current?.click()}>
        {uploading ? 'Yükleniyor…' : document ? 'Yenisini yükle' : 'Yükle'}
      </Button>
    </div>
  );
}
