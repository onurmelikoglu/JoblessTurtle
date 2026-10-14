/**
 * Adres aramasının hafızası ve basamakları. Bir firma için yapılan arama, bulduğu sonuçla birlikte hatırlanır; aynı
 * derinlikteki arama süresi dolmadan tekrarlanmaz ve derinleştirme yalnızca daha önce denenmemiş basamaklardan sürer.
 *
 * Basamaklar: base (varsayılan sağlayıcı ve model) → second (ikinci sağlayıcının güçlü modeli) → max (en güçlü model).
 */
export const SEARCH_DEPTHS = ['base', 'second', 'max'] as const;
export type SearchDepth = (typeof SEARCH_DEPTHS)[number];

/** Sonuçsuz kalan aramanın kendiliğinden yeniden denenmesi için beklenen süre. */
export const SEARCH_RETRY_DAYS = 30;
/** Kullanıcı ısrar etse de en derin arama bu süreden sık tekrarlanmaz. */
export const FORCED_SEARCH_RETRY_DAYS = 7;

const DAY_MS = 86_400_000;

export interface SearchMemory {
  contactsSearchedAt?: string;
  contactsDepth?: SearchDepth;
  /** Derinlik alanı eklenmeden önceki kayıt: yükseltmeli arama yapıldı. */
  contactsEscalated?: boolean;
}

export interface SearchRequest {
  /** Derin arama: gerekirse en güçlü modele kadar çıkılır. Arka plan araması yalnızca ilk basamağı çalıştırır. */
  deep: boolean;
  /** Kullanıcı bu firma için aramayı açıkça yeniden istedi. */
  force?: boolean;
  /** Bu andan önceki aramalar sayılmaz (ör. bilinen adres geri döndükten sonra durum değişmiştir). */
  since?: Date | null;
}

export type SearchSkip = 'recent' | 'exhausted';

export interface SearchPlan {
  rungs: SearchDepth[];
  skip: SearchSkip | null;
}

export function rememberedDepth(memory: SearchMemory | null | undefined): SearchDepth | null {
  if (!memory?.contactsSearchedAt) return null;
  return memory.contactsDepth ?? (memory.contactsEscalated ? 'max' : 'base');
}

export function contactSearchPlan(memory: SearchMemory | null | undefined, request: SearchRequest, now = Date.now()): SearchPlan {
  const target: SearchDepth = request.deep ? 'max' : 'base';
  const wanted = SEARCH_DEPTHS.slice(0, SEARCH_DEPTHS.indexOf(target) + 1);
  const depth = rememberedDepth(memory);
  const searchedAt = memory?.contactsSearchedAt ? new Date(memory.contactsSearchedAt).getTime() : 0;
  const windowMs = (request.force ? FORCED_SEARCH_RETRY_DAYS : SEARCH_RETRY_DAYS) * DAY_MS;
  const remembered = !!depth && now - searchedAt < windowMs && !(request.since && searchedAt < request.since.getTime());
  if (!remembered) return { rungs: wanted, skip: null };
  const rungs = wanted.filter((rung) => SEARCH_DEPTHS.indexOf(rung) > SEARCH_DEPTHS.indexOf(depth));
  if (rungs.length) return { rungs, skip: null };
  return { rungs: [], skip: request.deep ? 'exhausted' : 'recent' };
}

export interface SearchFindings {
  /** İK ya da işe alıma ait güvenilir bir adres bulundu. */
  recruiting: boolean;
  /** Gönderilebilir herhangi bir adres (genel iletişim dahil) bulundu. */
  sendable: boolean;
}

/**
 * Bir basamaktan sonra üsttekine çıkılsın mı: güvenilir İK adresi bulunduysa durulur; yalnızca genel adres bulunduysa
 * bir kez ikinci görüş alınır; hiç gönderilebilir adres yoksa en güçlü modele kadar çıkılır.
 */
export function shouldEscalate(after: SearchDepth, findings: SearchFindings): boolean {
  if (findings.recruiting) return false;
  if (after === 'base') return true;
  return after === 'second' && !findings.sendable;
}
