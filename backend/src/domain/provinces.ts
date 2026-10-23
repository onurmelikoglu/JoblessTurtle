import { fold } from './text';

/** Türkiye'nin 81 ili, plaka koduna göre. Indeed konum kodu ("T34") ilçe adlarını doğru ile bağlamak için kullanılır. */
const PROVINCES = [
  'Adana', 'Adıyaman', 'Afyonkarahisar', 'Ağrı', 'Amasya', 'Ankara', 'Antalya', 'Artvin', 'Aydın', 'Balıkesir',
  'Bilecik', 'Bingöl', 'Bitlis', 'Bolu', 'Burdur', 'Bursa', 'Çanakkale', 'Çankırı', 'Çorum', 'Denizli',
  'Diyarbakır', 'Edirne', 'Elazığ', 'Erzincan', 'Erzurum', 'Eskişehir', 'Gaziantep', 'Giresun', 'Gümüşhane', 'Hakkari',
  'Hatay', 'Isparta', 'Mersin', 'İstanbul', 'İzmir', 'Kars', 'Kastamonu', 'Kayseri', 'Kırklareli', 'Kırşehir',
  'Kocaeli', 'Konya', 'Kütahya', 'Malatya', 'Manisa', 'Kahramanmaraş', 'Mardin', 'Muğla', 'Muş', 'Nevşehir',
  'Niğde', 'Ordu', 'Rize', 'Sakarya', 'Samsun', 'Siirt', 'Sinop', 'Sivas', 'Tekirdağ', 'Tokat',
  'Trabzon', 'Tunceli', 'Şanlıurfa', 'Uşak', 'Van', 'Yozgat', 'Zonguldak', 'Aksaray', 'Bayburt', 'Karaman',
  'Kırıkkale', 'Batman', 'Şırnak', 'Bartın', 'Ardahan', 'Iğdır', 'Yalova', 'Karabük', 'Kilis', 'Osmaniye',
  'Düzce',
];

export function provinceByPlate(plate: number): string | null {
  return Number.isInteger(plate) && plate >= 1 && plate <= PROVINCES.length ? PROVINCES[plate - 1] : null;
}

/** Adı koşula uyan il ("istanbul" adres ekine karşılık gelen il gibi); yoksa null. */
export function findProvince(matches: (name: string) => boolean): string | null {
  return PROVINCES.find(matches) ?? null;
}

/** İl adının sitelerin adres eklerinde kullanılan biçimi: "İstanbul" → "istanbul", "Kahramanmaraş" → "kahramanmaras". */
export function citySlug(city: string): string {
  return fold(city).replace(/\s+/g, '-');
}

/** Adres ekinin ilk parçası ("istanbul-anadolu", "istanbul+avrupa-sisli" → "istanbul") bir ilse o il. */
export function provinceOfSlug(slug: string | null | undefined): string | null {
  const head = slug?.split(/[+-]/)[0];
  return head ? findProvince((name) => citySlug(name) === head) : null;
}

/** İlin plaka kodu ("İstanbul" → 34); il değilse null. */
export function plateOf(city: string): number | null {
  const index = PROVINCES.findIndex((name) => fold(name) === fold(city));
  return index < 0 ? null : index + 1;
}
