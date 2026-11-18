/**
 * Aday belgelerinin dil sürümleri. Başvuru yazıları Türkçe hazırlanır; aynı CV ya da portföyün İngilizce sürümü
 * yüklendiyse yazı İngilizceye çevrildiğinde ekler de İngilizce sürümlere geçer. Dil açıkça istenmeyen her yerde
 * Türkçe sürüm esastır: İngilizce sürüm daha yeni yüklenmiş olsa bile Türkçe yazıya eklenmez.
 */
export const PRIMARY_LANGUAGE = 'tr';
export const ENGLISH_LANGUAGE = 'en';
export const ATTACHED_TYPES = ['cv', 'portfolio'] as const;
/** Gönderilmemiş, eki ve metni hâlâ değiştirilebilen taslak durumları. */
export const EDITABLE_DRAFT_STATES = ['draft', 'needs_review'];

/**
 * CV sürümleri: kullanıcının yüklediği orijinal, dildeki ana ATS sürümü ve yalnızca bir ilan için üretilen ATS sürümü.
 * Varsayılan ek seçimi, CV bilgisi çıkarma ve sürüm numarası yalnızca orijinallerle yapılır.
 */
export const ORIGINAL_VARIANT = 'original';
export const ATS_MAIN_VARIANT = 'ats_main';
export const ATS_JOB_VARIANT = 'ats_job';
export type DocumentVariant = typeof ORIGINAL_VARIANT | typeof ATS_MAIN_VARIANT | typeof ATS_JOB_VARIANT;

export interface LanguageDocument {
  id: string;
  type: string;
  language: string;
  createdAt: Date;
  variant?: string;
  targetJobId?: string | null;
}

const variantKey = (d: LanguageDocument) => `${d.variant ?? ORIGINAL_VARIANT}:${d.targetJobId ?? ''}`;

const newestFirst = <T extends LanguageDocument>(docs: T[]) => [...docs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

/** Türün en güncel belgesi: önce istenen dilde, o dilde yoksa herhangi bir dilde. Belgeler kullanılabilir olanlardan (temiz, arşivsiz) seçilmelidir. */
export function pickDocument<T extends LanguageDocument>(docs: T[], type: string, language = PRIMARY_LANGUAGE): T | null {
  const ofType = newestFirst(docs.filter((d) => d.type === type));
  return ofType.find((d) => d.language === language) ?? ofType[0] ?? null;
}

/** Başvuruya varsayılan olarak eklenen belgeler (CV ve portföy) istenen dilde. */
export function attachmentsFor<T extends LanguageDocument>(docs: T[], language = PRIMARY_LANGUAGE): string[] {
  return ATTACHED_TYPES.map((type) => pickDocument(docs, type, language)?.id).filter((id): id is string => !!id);
}

/**
 * Yazının dili değişince ekler: her ek, aynı türün hedef dildeki en güncel sürümüyle değişir. Hedef dilde sürümü
 * olmayan ek (ya da elle eklenmiş başka tür belge) olduğu gibi kalır.
 */
export function attachmentsInLanguage<T extends LanguageDocument>(current: T[], available: T[], language: string): string[] {
  const ids = current.map((doc) => {
    if (doc.language === language) return doc.id;
    const inLanguage = newestFirst(available.filter((d) => d.type === doc.type && d.language === language));
    // ATS sürümü hedef dilde aynı sürümle (yoksa orijinalle) değişir; başka ilanın sürümüne geçilmez.
    const target = inLanguage.find((d) => variantKey(d) === variantKey(doc)) ?? inLanguage.find((d) => (d.variant ?? ORIGINAL_VARIANT) === ORIGINAL_VARIANT);
    return target?.id ?? doc.id;
  });
  return [...new Set(ids)];
}

/** Yerine yenisi yüklenmiş (arşivlenmiş) ekin güncel karşılığı: aynı tür ve aynı dil, yoksa aynı tür. */
export function replacementFor<T extends LanguageDocument>(doc: Pick<T, 'type' | 'language'>, available: T[]): T | null {
  return pickDocument(available, doc.type, doc.language);
}
