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
/** Kullanıcının istediği arama bekleme süresine bakmaz; yalnızca art arda tıklamada aynı firma bu süre içinde yeniden aranmaz. */
export const FORCED_SEARCH_RETRY_HOURS = 1;
/**
 * Derin aramanın yöntem sürümü. Yöntem değişince (2: firma sitesi benimseme, posta sunucusu yoklaması, yaygın adres
 * tahmini) eski sürümle "tükendi" sayılan firmalar yeni yöntemle bir kez daha derin aranabilir.
 */
export const SEARCH_VERSION = 2;
/** Yeni bilgi (yeni ilan, öğrenilen alan adı) aramayı erken açsa da aynı firma bundan sık aranmaz. */
export const NEW_INFO_MIN_DAYS = 2;

const DAY_MS = 86_400_000;

/**
 * Adres bulunamayan firmanın kendiliğinden yeniden aranma takvimi: ilk sonuçsuz aramadan sonra ilk süre, ikinciden sonra
 * ikinci süre, sonrakilerde son süre beklenir. Gerçekten adres yayımlamayan firma zamanla kota harcamayı bırakır.
 */
export const RETRY_PLANS = { often: [3, 14, 60], normal: [7, 30, 90], rare: [30, 90, 180] } as const;
export type RetryPlan = keyof typeof RETRY_PLANS;
export const RETRY_PLAN_NAMES = Object.keys(RETRY_PLANS) as RetryPlan[];

export const MAX_OPUS_DAILY_LIMIT = 50;

export interface ContactSearchSettings {
  retryPlan: RetryPlan;
  /** Sonnet adres bulamazsa ya da firma hiç Opus ile aranmadıysa arama bir kez Opus ile yapılır. */
  opusRetry: boolean;
  /** Opus ile günde en çok kaç firma aranır (aramanın içindeki tekrar ve günlük tarama birlikte sayılır). */
  opusDailyLimit: number;
  /** Firmanın yeni ilanı çıkınca ya da alan adı öğrenilince bekleme süresi dolmadan yeniden aranır. */
  retryOnNewInfo: boolean;
}

export const DEFAULT_CONTACT_SEARCH_SETTINGS: ContactSearchSettings = { retryPlan: 'normal', opusRetry: true, opusDailyLimit: 15, retryOnNewInfo: true };

export function contactSearchSettingsOf(stored: Partial<ContactSearchSettings> | null | undefined): ContactSearchSettings {
  const s = { ...DEFAULT_CONTACT_SEARCH_SETTINGS, ...(stored ?? {}) };
  return { ...s, retryPlan: RETRY_PLAN_NAMES.includes(s.retryPlan) ? s.retryPlan : DEFAULT_CONTACT_SEARCH_SETTINGS.retryPlan };
}

export interface SearchMemory {
  contactsSearchedAt?: string;
  contactsDepth?: SearchDepth;
  /** Derinlik alanı eklenmeden önceki kayıt: yükseltmeli arama yapıldı. */
  contactsEscalated?: boolean;
  /** Son derin aramanın yöntem sürümü; alan yoksa 1. */
  contactsVersion?: number;
  /** Son aramadan sonra firmanın İK ya da başvuru adresi var mı. */
  contactsFound?: boolean;
  /** Art arda kaç arama gönderilebilir adres getirmedi. */
  emptyStreak?: number;
  /** Adres araması en son ne zaman Opus ile yapıldı. */
  opusSearchedAt?: string;
  /** Son arama yapılırken firmanın alan adı biliniyor muydu. */
  searchedWithDomain?: boolean;
}

export interface SearchRequest {
  /** Derin arama: gerekirse en güçlü modele kadar çıkılır. Arka plan araması yalnızca ilk basamağı çalıştırır. */
  deep: boolean;
  /** Kullanıcı bu firma için aramayı açıkça yeniden istedi. */
  force?: boolean;
  /** Bu andan önceki aramalar sayılmaz (ör. bilinen adres geri döndükten sonra durum değişmiştir). */
  since?: Date | null;
  /** Firma hakkında son aramadan sonra öğrenilen yeni bilginin zamanı (ör. yeni ilan); bekleme süresini kısaltır. */
  newInfoAt?: Date | null;
  /** Firma hiç Opus ile aranmadıysa bekleme süresine bakılmadan bir kez Opus ile aranır. */
  opus?: boolean;
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

/** Sonuçsuz aramanın kaçıncı kez tekrarlandığı; eski kayıtlarda sayaç yoksa "adres yok" bilgisinden çıkarılır. */
function emptyStreakOf(memory: SearchMemory) {
  if (memory.emptyStreak !== undefined) return memory.emptyStreak;
  return memory.contactsFound === false ? 1 : 0;
}

/** Aynı derinlikteki aramanın kendiliğinden tekrarlanması için beklenecek gün. */
export function retryWindowDays(memory: SearchMemory | null | undefined, request: Pick<SearchRequest, 'force'>, retryDays: readonly number[] = RETRY_PLANS.normal) {
  const streak = memory ? emptyStreakOf(memory) : 0;
  const base = streak > 0 ? retryDays[Math.min(streak, retryDays.length) - 1] : SEARCH_RETRY_DAYS;
  return request.force ? Math.min(base, FORCED_SEARCH_RETRY_HOURS / 24) : base;
}

export function contactSearchPlan(memory: SearchMemory | null | undefined, request: SearchRequest, now = Date.now(), retryDays?: readonly number[]): SearchPlan {
  const target: SearchDepth = request.deep ? 'max' : 'base';
  const wanted = SEARCH_DEPTHS.slice(0, SEARCH_DEPTHS.indexOf(target) + 1);
  if (request.opus && !memory?.opusSearchedAt) return { rungs: wanted, skip: null };
  const depth = rememberedDepth(memory);
  const searchedAt = memory?.contactsSearchedAt ? new Date(memory.contactsSearchedAt).getTime() : 0;
  const windowMs = retryWindowDays(memory, request, retryDays) * DAY_MS;
  const newInfo = !!request.newInfoAt && request.newInfoAt.getTime() > searchedAt && now - searchedAt >= NEW_INFO_MIN_DAYS * DAY_MS;
  const remembered = !!depth && now - searchedAt < windowMs && !(request.since && searchedAt < request.since.getTime()) && !newInfo;
  if (!remembered) return { rungs: wanted, skip: null };
  const rungs = wanted.filter((rung) => SEARCH_DEPTHS.indexOf(rung) > SEARCH_DEPTHS.indexOf(depth));
  if (rungs.length) return { rungs, skip: null };
  return { rungs: [], skip: request.deep ? 'exhausted' : 'recent' };
}

/** Sonuçsuz kalan firmanın kendiliğinden yeniden aranacağı an; adres bulunduysa ya da hiç aranmadıysa null. */
export function nextAutomaticSearchAt(memory: SearchMemory | null | undefined, retryDays?: readonly number[]): Date | null {
  if (!memory?.contactsSearchedAt || emptyStreakOf(memory) === 0) return null;
  return new Date(new Date(memory.contactsSearchedAt).getTime() + retryWindowDays(memory, {}, retryDays) * DAY_MS);
}

/** Firma kartındaki adres araması özeti; hiç aranmadıysa null. */
export function addressSearchOf(memory: SearchMemory | null | undefined, retryDays?: readonly number[]) {
  if (!memory?.contactsSearchedAt) return null;
  const emptyStreak = emptyStreakOf(memory);
  return {
    searchedAt: new Date(memory.contactsSearchedAt),
    found: emptyStreak === 0,
    emptyStreak,
    nextAt: nextAutomaticSearchAt(memory, retryDays),
    opusAt: memory.opusSearchedAt ? new Date(memory.opusSearchedAt) : null,
  };
}
