import { fold } from './text';

export type WorkMode = 'onsite' | 'hybrid' | 'remote';

/** Sitenin çalışma şekli alanı ya da konum metni ("İş Yerinde", "Hibrit", "Uzaktan", "Kısmen uzaktan"). */
export function workModeOf(text: string | null | undefined): WorkMode | null {
  const f = fold(text);
  if (!f) return null;
  if (/\b(hibrit|hybrid|kismen uzaktan|partially remote)\b/.test(f)) return 'hybrid';
  if (/\b(uzaktan|remote|evden)\b/.test(f)) return 'remote';
  if (/\b(is yerinde|ofiste|on site|onsite|yerinde)\b/.test(f)) return 'onsite';
  return null;
}

const HYBRID_PHRASE = /\b(hibrit|hybrid|kismen uzaktan|partially remote)\b/;
/** Tek başına "uzaktan" ("Uzaktan Eğitim Koordinatörü") çalışma şekli sayılmaz; çalışmayla birlikte geçmelidir. */
const REMOTE_PHRASE = /\b(remote|tamamen uzaktan|uzaktan calis\w*|evden calis\w*|home office|work from home)\b/;

/** Unvan ya da ilan metninde açıkça geçen çalışma şekli ("Remote Flutter Developer", "hibrit çalışma modeli"). */
export function workModeInText(text: string | null | undefined): WorkMode | null {
  const f = fold(text);
  if (!f) return null;
  if (HYBRID_PHRASE.test(f)) return 'hybrid';
  if (REMOTE_PHRASE.test(f)) return 'remote';
  return null;
}

/** Mahalle, cadde, sokak ya da kapı numarası: ilanın belirli bir iş yerine bağlı olduğunu gösterir. */
const STREET_ADDRESS = /\b(mah|mahallesi|cad|caddesi|cd|sok|sokak|sokagi|sk|bulvari|blv|no)\b/;

/** Yerinde yapılan işler: saha, mağaza, üretim, lojistik, sağlık, eğitim, konaklama ve yiyecek-içecek. */
const ONSITE_ROLE =
  /\b(garson|komi|asci|bulasik\w*|kasiyer|kurye|sofor|surucu|depo|forklift|operator\w*|uretim|montaj|kaynak\w*|tekniker|teknisyen|elektrikci|tesisat\w*|guvenlik gorevlisi|ozel guvenlik|temizlik|kat gorevlisi|resepsiyon\w*|barista|magaza|reyon|satis danismani|hemsire|ebe|hasta bakici|bakici|ogretmen\w*|usta\w*|kalfa|cirak|isci|saha|santiye|laborant|eczaci|eczane|on buro|sekreter|bellboy|vale|paketleme|sevkiyat|makinist|terzi|kuafor|estetisyen|fizyoterapist|veteriner)\b/;

/** Masa başında, çoğunlukla hibrit yürütülen dijital işler. */
const DIGITAL_ROLE =
  /\b(yazilim|software|developer|gelistirici|frontend|front end|backend|back end|full ?stack|mobile|ios|android|flutter|react|devops|cloud|veri bilim\w*|veri analist\w*|data (scientist|analyst|engineer)|machine learning|yapay zeka|ux|ui|product (manager|owner|designer)|urun yonetici\w*|grafik tasarim\w*|designer|tasarimci|dijital pazarlama|digital marketing|seo|sem|copywriter|icerik (uzmani|editoru)|qa|test (uzmani|muhendisi)|siber guvenlik|cyber security)\b/;

export interface WorkModeClues {
  title: string;
  description?: string | null;
  /** Konum ya da adres metni; sokak düzeyinde adres iş yerine işaret eder. */
  location?: string | null;
}

/**
 * İlanda çalışma şekli yazmıyorsa tahmini: açıklamadaki açık ifade, sokak düzeyinde adres, unvanın iş türü; hiçbiri
 * yoksa Türkiye'deki ilanların çoğunluğu gibi iş yerinde. Tahmin yalnızca gösterim içindir; süzgeçler (uzaktan, şehir)
 * yalnızca ilanda yazan çalışma şeklini kullanır.
 */
export function estimateWorkMode(clues: WorkModeClues): WorkMode {
  const stated = workModeInText(clues.description);
  if (stated) return stated;
  if (STREET_ADDRESS.test(fold(clues.location))) return 'onsite';
  const title = fold(clues.title);
  if (ONSITE_ROLE.test(title)) return 'onsite';
  if (DIGITAL_ROLE.test(title)) return 'hybrid';
  return 'onsite';
}
