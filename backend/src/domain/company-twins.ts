import { domainRootOf, nameKeysOf } from './company-identity';
import { fold, normalizeCompanyName } from './text';

/**
 * Aynı firmanın farklı adla açılmış kayıtları (ör. ilan sitelerinde "DURU TAŞ LTD ŞTİ" ve "DURU TAŞ YAPI İNŞ.
 * LTD. ŞTİ."). Ad çekirdeği hukuki ekler, yer adları ve sektör kısaltmaları atılarak çıkarılır. Yalnız ad benzerliği
 * öneri olur; otomatik birleştirme için ad çekirdeği güçlü olmalı ve en az bir bağımsız kanıt (aynı ilan, aynı mail
 * alan adı ya da aynı ilçede ofis) bulunmalı. Alan adı kökü aynıysa kanıt aranmaz; ikisinin de bilinen alan adı
 * farklıysa asla otomatik birleştirilmez.
 */
const DROPPED_WORDS = new Set(
  (
    'turkiye turkey tr istanbul ankara izmir kocaeli bursa antalya avrupa anadolu yakasi merkez genel mudurluk mudurlugu ofis office subesi sube ' +
    'group grup grubu holding global international company co limited ltd sti sirket sirketi sirketleri as anonim inc llc gmbh the ve and of ' +
    'tic ticaret san sanayi ith ithalat ihr ihracat dis paz pazarlama hiz hizmet hizmetleri ins insaat yapi mak makina makine muh muhendislik ' +
    'mim mimarlik taah taahhut uretim imalat gida tekstil turizm otomotiv elektrik elektronik enerji lojistik nakliyat tasimacilik danismanlik ' +
    'yazilim bilisim bilgisayar teknoloji teknolojileri technology technologies tech medya reklam reklamcilik organizasyon saglik egitim emlak ' +
    'tarim kimya plastik metal celik mobilya dekorasyon tasarim design studio studyo ajans ajansi agency yatirim finans sigorta aracilik'
  ).split(' '),
);
const MIN_STRONG_CORE_LENGTH = 8;

/** Ad çekirdeği: "DURU TAŞ YAPI İNŞ. LTD. ŞTİ." → "duru tas". */
export function strictCoreOf(name: string): string {
  const words = normalizeCompanyName(name.replace(/\([^)]*\)/g, ' '))
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(' ')
    .filter((w) => w && !DROPPED_WORDS.has(w));
  return words.join(' ');
}

/** Tek ve kısa sözcük ("duru") başka firmalarla kolayca çakışır; otomatik birleştirmeye yetmez. */
export const isStrongCore = (core: string) => core.split(' ').length >= 2 || core.length >= MIN_STRONG_CORE_LENGTH;

export interface TwinProfile {
  id: string;
  name: string;
  domains: (string | null | undefined)[];
  /** Firmanın ilanları: normalize unvan ve şehir/ilçe. */
  jobs: { title: string; place: string | null }[];
  emailDomains: string[];
  officePlaces: string[];
}

export type TwinVerdict = { level: 'certain' | 'likely'; reasons: string[] } | null;

const rootsOf = (p: TwinProfile) => new Set([...p.domains.map(domainRootOf), ...p.emailDomains.map(domainRootOf)].filter((r): r is string => !!r));
const ownRootsOf = (p: TwinProfile) => new Set(p.domains.map(domainRootOf).filter((r): r is string => !!r));
const placeKey = (place: string | null) => (place ? fold(place).replace(/[^a-z0-9]+/g, ' ').trim() : '');

function sharedJob(a: TwinProfile, b: TwinProfile): string | null {
  const keys = new Set(a.jobs.map((j) => `${j.title}|${placeKey(j.place)}`));
  return b.jobs.find((j) => keys.has(`${j.title}|${placeKey(j.place)}`))?.title ?? null;
}

/**
 * Alan adı kökü adın baştaki sözcükleriyle örtüşüyor mu: "lodos" ↔ "Lodos Engage İstanbul", "maviyelken" ↔ "Mavi Yelken
 * Turizm". Araştırmada yanlış atanmış bir site ("ilgaz" ↔ "Üç Kavak Ilgaz Giyim") kesin sayılmasın diye.
 */
export function rootMatchesName(root: string, name: string): boolean {
  const words = normalizeCompanyName(name.replace(/\([^)]*\)/g, ' ')).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean);
  let prefix = '';
  for (const word of words) {
    prefix += word;
    if (prefix === root) return true;
    if (prefix.length >= root.length) return false;
  }
  return false;
}

const intersects = <T>(a: Set<T>, b: Iterable<T>) => [...b].some((x) => a.has(x));

/** Bir sözcük dizisi diğerinin başı mı: "duru tas" ↔ "duru tas mermer". */
function tokenPrefix(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const s = short.split(' ');
  const l = long.split(' ');
  return s.length >= 2 && s.every((w, i) => l[i] === w);
}

export function twinVerdict(a: TwinProfile, b: TwinProfile): TwinVerdict {
  if (a.id === b.id) return null;
  const ownA = ownRootsOf(a);
  const ownB = ownRootsOf(b);
  const conflictingSites = ownA.size > 0 && ownB.size > 0 && !intersects(ownA, ownB);
  const sharedRoot = [...ownA].find((r) => ownB.has(r));
  if (sharedRoot && rootMatchesName(sharedRoot, a.name) && rootMatchesName(sharedRoot, b.name)) return { level: 'certain', reasons: ['Aynı web sitesi'] };
  if (sharedRoot) return { level: 'likely', reasons: ['Aynı web sitesi', 'Ancak adlar alan adıyla örtüşmüyor; site yanlış eşleşmiş olabilir'] };

  const coreA = strictCoreOf(a.name);
  const coreB = strictCoreOf(b.name);
  const sameCore = !!coreA && coreA === coreB;
  const sameKey = intersects(new Set(nameKeysOf(a.name)), nameKeysOf(b.name));
  const prefix = !!coreA && !!coreB && tokenPrefix(coreA, coreB);
  if (!sameCore && !sameKey && !prefix) return null;

  const evidence: string[] = [];
  const job = sharedJob(a, b);
  if (job) evidence.push(`Aynı ilan: ${job}`);
  if (intersects(rootsOf(a), rootsOf(b))) evidence.push('Aynı mail alan adı');
  const placesA = new Set(a.officePlaces.map(placeKey).filter(Boolean));
  if (b.officePlaces.map(placeKey).some((p) => placesA.has(p))) evidence.push('Aynı yerde ofis');

  const nameReason = sameCore || sameKey ? 'Ad aynı (hukuki ekler ve sektör sözcükleri dışında)' : 'Adlardan biri diğerinin devamı';
  const sharedKey = nameKeysOf(a.name).find((k) => nameKeysOf(b.name).includes(k)) ?? '';
  const strong = (sameCore && isStrongCore(coreA)) || (sameKey && isStrongCore(sharedKey));
  if (!conflictingSites && strong && evidence.length > 0) return { level: 'certain', reasons: [nameReason, ...evidence] };
  if (!strong && evidence.length === 0) return null;
  return { level: 'likely', reasons: [nameReason, ...evidence, ...(conflictingSites ? ['Ancak web siteleri farklı'] : [])] };
}

/**
 * Çalışma alanındaki olası ikizler. Karşılaştırma yalnız aynı ilk ad sözcüğünü paylaşan firmalar arasında yapılır;
 * her çift bir kez döner.
 */
export function findTwins(profiles: TwinProfile[]): { a: TwinProfile; b: TwinProfile; verdict: NonNullable<TwinVerdict> }[] {
  const buckets = new Map<string, TwinProfile[]>();
  const add = (key: string, p: TwinProfile) => buckets.set(key, [...(buckets.get(key) ?? []), p]);
  for (const p of profiles) {
    const first = strictCoreOf(p.name).split(' ')[0];
    if (first) add(`n:${first}`, p);
    for (const root of ownRootsOf(p)) add(`d:${root}`, p);
  }
  const seen = new Set<string>();
  const out: { a: TwinProfile; b: TwinProfile; verdict: NonNullable<TwinVerdict> }[] = [];
  for (const group of buckets.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = group[i].id < group[j].id ? [group[i], group[j]] : [group[j], group[i]];
        const key = `${a.id}|${b.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const verdict = twinVerdict(a, b);
        if (verdict) out.push({ a, b, verdict });
      }
    }
  }
  return out;
}

export const twinPairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
