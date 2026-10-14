import { useState } from 'react';
import { homeApi, type DocumentType } from '@/api/home';
import { useAction } from '@/api/queries';
import type { HomeSetup } from '@/api/types';
import { DocumentRow } from '@/features/shared/DocumentRow';
import { DOCUMENT_LABELS } from '@/features/shared/documents';
import { toast } from '@/ui/toast';
import { CANDIDATE_REQUIRED } from './constants';
import { Section } from './parts';

const ROW_LABELS: Record<DocumentType, string> = { cv: 'CV', portfolio: 'Portföy dosyası' };
const DOCUMENT_TYPES: DocumentType[] = ['cv', 'portfolio'];

interface DocumentsSectionProps {
  setup: HomeSetup;
  onPolicy: (blocker: string | null) => void;
}

export function DocumentsSection({ setup, onPolicy }: DocumentsSectionProps) {
  const { busy, run } = useAction();
  const [uploading, setUploading] = useState<DocumentType | null>(null);
  const candidateId = setup.candidate?.id;

  const upload = async (type: DocumentType, file: File) => {
    if (!candidateId) return toast.error(CANDIDATE_REQUIRED);
    setUploading(type);
    await run(
      async () => {
        await homeApi.uploadDocument(candidateId, type, file);
        const synced = await homeApi.syncPolicy();
        onPolicy(synced.policyBlocker);
      },
      { success: `${DOCUMENT_LABELS[type]} yüklendi. Yeni başvurularda bu dosya kullanılacak.` },
    );
    setUploading(null);
  };

  return (
    <Section title="CV ve portföy">
      <div className="divide-y divide-line">
        {DOCUMENT_TYPES.map((type) => (
          <DocumentRow key={type} label={ROW_LABELS[type]} document={setup[type]} uploading={uploading === type} disabled={busy || uploading !== null} onPick={(file) => void upload(type, file)} />
        ))}
      </div>
    </Section>
  );
}
