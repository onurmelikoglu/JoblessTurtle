import type { InboxItem } from '@/api/types';
import { haystack, matchesAll, tokensOf } from '@/lib/text';
import { isInboxTodo } from './model';

export const INBOX_VIEWS = ['todo', 'replies', 'delivered', 'all'] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export const INBOX_VIEW_LABELS: Record<InboxView, string> = { todo: 'Müdahale gerekenler', replies: 'Firma yanıtları', delivered: 'Ulaştı / bilgi', all: 'Tümü' };

const IN_VIEW: Record<InboxView, (item: InboxItem) => boolean> = {
  todo: isInboxTodo,
  replies: (item) => item.group === 'reply',
  delivered: (item) => item.group === 'delivered' || item.group === 'pending',
  all: () => true,
};

export function inboxViewCounts(items: InboxItem[]): Record<InboxView, number> {
  return Object.fromEntries(INBOX_VIEWS.map((view) => [view, items.filter(IN_VIEW[view]).length])) as Record<InboxView, number>;
}

export function filterInbox(items: InboxItem[], view: InboxView, query: string): InboxItem[] {
  const tokens = tokensOf(query);
  return items.filter((item) => IN_VIEW[view](item) && (tokens.length === 0 || matchesAll(tokens, haystack([item.company, item.label, item.reason, item.toEmail, item.fromEmail, item.subject, item.suggestedEmail]))));
}
