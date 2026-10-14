/**
 * Aday belgelerinin dil sürümleri. Başvuru yazıları Türkçe hazırlanır; aynı CV ya da portföyün İngilizce sürümü
 * yüklendiyse yazı İngilizceye çevrildiğinde ekler de İngilizce sürümlere geçer. Dil açıkça istenmeyen her yerde
 * Türkçe sürüm esastır: İngilizce sürüm daha yeni yüklenmiş olsa bile Türkçe yazıya eklenmez.
 */
export const PRIMARY_LANGUAGE = 'tr';
export const ENGLISH_LANGUAGE = 'en';
export const ATTACHED_TYPES = ['cv', 'portfolio'] as const;

export interface LanguageDocument {
  id: string;
  type: string;
  language: string;
  createdAt: Date;
}

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
    const target = newestFirst(available.filter((d) => d.type === doc.type && d.language === language))[0];
    return target?.id ?? doc.id;
  });
  return [...new Set(ids)];
}

/** Yerine yenisi yüklenmiş (arşivlenmiş) ekin güncel karşılığı: aynı tür ve aynı dil, yoksa aynı tür. */
export function replacementFor<T extends LanguageDocument>(doc: Pick<T, 'type' | 'language'>, available: T[]): T | null {
  return pickDocument(available, doc.type, doc.language);
}
