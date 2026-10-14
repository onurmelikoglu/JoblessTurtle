declare const isoDate: unique symbol;

/** JSON'da ISO 8601 metni olarak taşınan tarih; sunucu tarafında Date nesnesidir (bkz. ServerShape). */
export type IsoDate = string & { readonly [isoDate]: true };

/** Sözleşme tipinin sunucudaki karşılığı: IsoDate alanları Date olur, gerisi aynı kalır. */
export type ServerShape<T> = T extends IsoDate ? Date : T extends (infer U)[] ? ServerShape<U>[] : T extends object ? { [K in keyof T]: ServerShape<T[K]> } : T;
