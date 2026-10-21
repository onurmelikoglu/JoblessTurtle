/**
 * Adres aramasının hafızası ve basamakları. Bir firma için yapılan arama, bulduğu sonuçla birlikte hatırlanır; aynı
 * derinlikteki arama süresi dolmadan tekrarlanmaz ve derinleştirme yalnızca daha önce denenmemiş basamaklardan sürer.
 *
 * Basamaklar: base (toplayıcı model web'de aday topladı) → max (denetçi model adayları da doğruladı). second, eski
 * üç basamaklı aramadan kalan kayıtlarda görülür; ondan sonra derin arama yalnızca doğrulama basamağıyla sürer.
 */
export const SEARCH_DEPTHS = ['base', 'second', 'max'] as const;
export type SearchDepth = (typeof SEARCH_DEPTHS)[number];

/** Sonuçsuz kalan aramanın kendiliğinden yeniden denenmesi için beklenen süre. */
export const SEARCH_RETRY_DAYS = 30;
/** Kullanıcı ısrar etse de en derin arama bu süreden sık tekrarlanmaz. */
export const FORCED_SEARCH_RETRY_DAYS = 7;
/**
 * Derin aramanın yöntem sürümü. Yöntem değişince (2: firma sitesi benimseme, posta sunucusu yoklaması, yaygın adres
 * tahmini) eski sürümle "tükendi" sayılan firmalar yeni yöntemle bir kez daha derin aranabilir.
 */
export const SEARCH_VERSION = 2;

const DAY_MS = 86_400_000;

export interface SearchMemory {
  contactsSearchedAt?: string;
  contactsDepth?: SearchDepth;
  /** Derinlik alanı eklenmeden önceki kayıt: yükseltmeli arama yapıldı. */
  contactsEscalated?: boolean;
  /** Son derin aramanın yöntem sürümü; alan yoksa 1. */
  contactsVersion?: number;
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

/** Eski yöntem sürümüyle ulaşılmış en derin basamak, yeni yöntemin doğrulama basamağını tekrar açık bırakır. */
export function rememberedDepth(memory: SearchMemory | null | undefined): SearchDepth | null {
  if (!memory?.contactsSearchedAt) return null;
  const depth = memory.contactsDepth ?? (memory.contactsEscalated ? 'max' : 'base');
  return depth === 'max' && (memory.contactsVersion ?? 1) < SEARCH_VERSION ? 'second' : depth;
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
