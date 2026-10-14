import { z } from 'zod';

export const pageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type PageQuery = z.infer<typeof pageQuery>;

/** Cursor sayfalama: limit+1 kayıt çekilir, fazlası varsa nextCursor döner. */
export function paginate<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

export function cursorArgs(q: PageQuery): { cursor?: { id: string }; skip?: number; take: number } {
  return q.cursor ? { cursor: { id: q.cursor }, skip: 1, take: q.limit + 1 } : { take: q.limit + 1 };
}
