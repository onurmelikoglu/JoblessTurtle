import { useState } from 'react';
import { homeApi, type DocumentLanguage, type DocumentType } from '@/api/home';
import { useAction } from '@/api/queries';
import type { HomeSetup } from '@/api/types';
import { DocumentRow } from '@/features/shared/DocumentRow';
import { DOCUMENT_LABELS } from '@/features/shared/documents';
import { toast } from '@/ui/toast';
import { CANDIDATE_REQUIRED } from './constants';
import { Section, SubSection } from './parts';

const ROW_LABELS: Record<DocumentType, string> = { cv: 'CV', portfolio: 'Portföy dosyası' };
const ENGLISH_ROW_LABELS: Record<DocumentType, string> = { cv: 'CV (İngilizce)', portfolio: 'Portföy dosyası (İngilizce)' };
const DOCUMENT_TYPES: DocumentType[] = ['cv', 'portfolio'];

interface DocumentsSectionProps {
  setup: HomeSetup;
  onPolicy: (blocker: string | null) => void;
}

const successMessage = (type: DocumentType, language: DocumentLanguage) =>
  language === 'en' ? `İngilizce ${DOCUMENT_LABELS[type].toLocaleLowerCase('tr')} yüklendi. Yazı İngilizceye çevrildiğinde ek olarak bu dosya gider.` : `${DOCUMENT_LABELS[type]} yüklendi. Yeni başvurularda bu dosya kullanılacak.`;

export function DocumentsSection({ setup, onPolicy }: DocumentsSectionProps) {
  const { busy, run } = useAction();
  const [uploading, setUploading] = useState<string | null>(null);
  const candidateId = setup.candidate?.id;

  const upload = async (type: DocumentType, language: DocumentLanguage, file: File) => {
    if (!candidateId) return toast.error(CANDIDATE_REQUIRED);
    setUploading(`${type}:${language}`);
    await run(
      async () => {
        await homeApi.uploadDocument(candidateId, type, file, language);
        const synced = await homeApi.syncPolicy();
        onPolicy(synced.policyBlocker);
      },
      { success: successMessage(type, language) },
    );
    setUploading(null);
  };

  const row = (type: DocumentType, language: DocumentLanguage) => (
    <DocumentRow
      key={`${type}:${language}`}
      label={language === 'en' ? ENGLISH_ROW_LABELS[type] : ROW_LABELS[type]}
      document={language === 'en' ? setup.english[type] : setup[type]}
      uploading={uploading === `${type}:${language}`}
      disabled={busy || uploading !== null}
      onPick={(file) => void upload(type, language, file)}
    />
  );

  return (
    <Section title="CV ve portföy">
      <div className="divide-y divide-line">{DOCUMENT_TYPES.map((type) => row(type, 'tr'))}</div>
      <SubSection title="İngilizce sürümler" description="Başvuru yazısını İngilizceye çevirdiğinde ekler kendiliğinden bu dosyalara geçer; Türkçeye döndürünce Türkçe sürümler eklenir. İngilizce sürüm yoksa Türkçe dosya gider.">
        <div className="divide-y divide-line">{DOCUMENT_TYPES.map((type) => row(type, 'en'))}</div>
      </SubSection>
    </Section>
  );
}
