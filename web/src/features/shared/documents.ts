import type { DocumentType } from '@/api/home';

export const DOCUMENT_ACCEPT = '.pdf,.docx,.pptx,.png,.jpg,.jpeg';
export const DOCUMENT_LABELS: Record<DocumentType, string> = { cv: 'CV', portfolio: 'Portföy' };

export function documentLabel(type: string): string {
  return type in DOCUMENT_LABELS ? DOCUMENT_LABELS[type as DocumentType] : 'Belge';
}
