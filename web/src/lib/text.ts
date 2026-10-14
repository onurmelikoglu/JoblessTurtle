const FOLD: Record<string, string> = { ı: 'i', ğ: 'g', ü: 'u', ş: 's', ö: 'o', ç: 'c', â: 'a', î: 'i', û: 'u' };

/** Türkçe karakter ve büyük/küçük harf farkını yok sayan arama biçimi ("İSTANBUL" ve "istanbul" aynı). */
export function fold(text: string): string {
  return text
    .replaceAll('İ', 'i')
    .replaceAll('I', 'ı')
    .toLowerCase()
    .replace(/[ığüşöçâîû]/g, (ch) => FOLD[ch] ?? ch)
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokensOf(query: string): string[] {
  return fold(query).split(' ').filter(Boolean);
}

/** Sorgudaki her kelime, alanlardan en az birinde geçmelidir (kelime sırası önemsiz). */
export function matchesAll(tokens: string[], foldedHaystack: string): boolean {
  return tokens.every((token) => foldedHaystack.includes(token));
}

export function haystack(parts: (string | null | undefined)[]): string {
  return fold(parts.filter(Boolean).join(' \u0001 '));
}
