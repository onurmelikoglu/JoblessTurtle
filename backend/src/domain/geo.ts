import { fold } from './text';

export const ISTANBUL_DISTRICTS: { name: string; side: 'anadolu' | 'avrupa' }[] = [
  ['Adalar', 'anadolu'], ['Arnavutköy', 'avrupa'], ['Ataşehir', 'anadolu'], ['Avcılar', 'avrupa'],
  ['Bağcılar', 'avrupa'], ['Bahçelievler', 'avrupa'], ['Bakırköy', 'avrupa'], ['Başakşehir', 'avrupa'],
  ['Bayrampaşa', 'avrupa'], ['Beşiktaş', 'avrupa'], ['Beykoz', 'anadolu'], ['Beylikdüzü', 'avrupa'],
  ['Beyoğlu', 'avrupa'], ['Büyükçekmece', 'avrupa'], ['Çatalca', 'avrupa'], ['Çekmeköy', 'anadolu'],
  ['Esenler', 'avrupa'], ['Esenyurt', 'avrupa'], ['Eyüpsultan', 'avrupa'], ['Fatih', 'avrupa'],
  ['Gaziosmanpaşa', 'avrupa'], ['Güngören', 'avrupa'], ['Kadıköy', 'anadolu'], ['Kağıthane', 'avrupa'],
  ['Kartal', 'anadolu'], ['Küçükçekmece', 'avrupa'], ['Maltepe', 'anadolu'], ['Pendik', 'anadolu'],
  ['Sancaktepe', 'anadolu'], ['Sarıyer', 'avrupa'], ['Silivri', 'avrupa'], ['Sultanbeyli', 'anadolu'],
  ['Sultangazi', 'avrupa'], ['Şile', 'anadolu'], ['Şişli', 'avrupa'], ['Tuzla', 'anadolu'],
  ['Ümraniye', 'anadolu'], ['Üsküdar', 'anadolu'], ['Zeytinburnu', 'avrupa'],
].map(([name, side]) => ({ name, side: side as 'anadolu' | 'avrupa' }));

export const ISTANBUL_SIDE_LABELS = { anadolu: 'İstanbul (Anadolu Yakası)', avrupa: 'İstanbul (Avrupa Yakası)' } as const;

export function regionForSelection(selection: string | null | undefined): { city: string | null; districtsPrimary: string[] } {
  const label = selection?.trim();
  if (!label) return { city: null, districtsPrimary: [] };
  const side = (Object.keys(ISTANBUL_SIDE_LABELS) as (keyof typeof ISTANBUL_SIDE_LABELS)[]).find((k) => ISTANBUL_SIDE_LABELS[k] === label);
  if (side) return { city: 'İstanbul', districtsPrimary: ISTANBUL_DISTRICTS.filter((d) => d.side === side).map((d) => d.name) };
  return { city: label, districtsPrimary: [label] };
}

export const CITY_SELECTION_SEPARATOR = '; ';

export function regionForSelections(selections: string[]): { city: string | null; districtsPrimary: string[] } {
  const regions = selections.map((s) => regionForSelection(s)).filter((r) => r.city);
  const cities = [...new Set(regions.map((r) => r.city))];
  return { city: cities.length === 1 ? cities[0] : null, districtsPrimary: [...new Set(regions.flatMap((r) => r.districtsPrimary))] };
}

/** Semt/iş merkezi → ilçe. Kullanıcı semt adını doğrudan hedef listesine de yazabilir (ör. Levent). */
export const NEIGHBORHOODS: Record<string, string> = {
  levent: 'Beşiktaş', etiler: 'Beşiktaş', ortakoy: 'Beşiktaş', bebek: 'Beşiktaş', zincirlikuyu: 'Beşiktaş',
  maslak: 'Sarıyer', istinye: 'Sarıyer', karakoy: 'Beyoğlu', cihangir: 'Beyoğlu', galata: 'Beyoğlu',
  taksim: 'Beyoğlu', nisantasi: 'Şişli', mecidiyekoy: 'Şişli', gayrettepe: 'Beşiktaş', fulya: 'Şişli',
  bomonti: 'Şişli', esentepe: 'Şişli', moda: 'Kadıköy', kozyatagi: 'Kadıköy', fenerbahce: 'Kadıköy',
  bostanci: 'Kadıköy', suadiye: 'Kadıköy', acibadem: 'Kadıköy', altunizade: 'Üsküdar', kisikli: 'Üsküdar',
  cengelkoy: 'Üsküdar', kavacik: 'Beykoz', eyup: 'Eyüpsultan', kagithane: 'Kağıthane', seyrantepe: 'Kağıthane',
  atasehir: 'Ataşehir', kucukbakkalkoy: 'Ataşehir', umraniye: 'Ümraniye', serifali: 'Ümraniye',
};

const DISTRICT_BY_FOLD = new Map(ISTANBUL_DISTRICTS.map((d) => [fold(d.name), d.name]));
DISTRICT_BY_FOLD.set('eyup', 'Eyüpsultan');

export interface DetectedLocation {
  district: string | null;
  neighborhood: string | null;
  city: string | null;
  remote: boolean;
  hybrid: boolean;
}

export function detectLocation(text: string | null | undefined): DetectedLocation {
  const f = ` ${fold(text)} `;
  const remote = /\b(remote|uzaktan|evden)\b/.test(f);
  const hybrid = /\b(hybrid|hibrit)\b/.test(f);
  let neighborhood: string | null = null;
  let district: string | null = null;
  for (const [n, d] of Object.entries(NEIGHBORHOODS)) {
    if (f.includes(` ${n} `)) {
      neighborhood = n;
      district = d;
      break;
    }
  }
  for (const [k, name] of DISTRICT_BY_FOLD) {
    if (f.includes(` ${k} `)) {
      district = name;
      break;
    }
  }
  let city: string | null = null;
  if (district || f.includes(' istanbul ')) city = 'İstanbul';
  else {
    const m = f.match(/\b(ankara|izmir|bursa|antalya|eskisehir|kocaeli|adana|london|berlin|amsterdam|dubai)\b/);
    if (m) city = m[1];
  }
  return { district, neighborhood, city, remote, hybrid };
}

export type LocationState = 'primary' | 'conditional' | 'remote' | 'outside' | 'unknown';

export interface RegionRules {
  city?: string | null;
  districtsPrimary: string[];
  districtsConditional: string[];
  allowRemote: boolean;
  allowHybrid: boolean;
}

function inList(list: string[], loc: DetectedLocation, rawText: string) {
  const f = ` ${fold(rawText)} `;
  return list.some((item) => {
    const k = fold(item);
    if (!k) return false;
    if (loc.district && fold(loc.district) === k) return true;
    if (loc.neighborhood && loc.neighborhood === k) return true;
    return f.includes(` ${k} `);
  });
}

/**
 * Görev ofisi esas alınır. Konum belirsizse "unknown" döner; otomatik başvuru bu durumda
 * kullanıcının ayrı kuralı olmadan ilerlemez.
 */
export function evaluateLocation(rules: RegionRules, locationText: string | null | undefined, workMode?: string): LocationState {
  const text = locationText ?? '';
  const loc = detectLocation(text);
  if ((workMode === 'remote' || (loc.remote && !loc.district)) && rules.allowRemote) return 'remote';
  if (inList(rules.districtsPrimary, loc, text)) return 'primary';
  if (inList(rules.districtsConditional, loc, text)) return 'conditional';
  if (loc.district) return 'outside';
  if (loc.city && rules.city && fold(loc.city) !== fold(rules.city)) return 'outside';
  if (loc.remote && !rules.allowRemote) return 'outside';
  return 'unknown';
}

const TURKISH_PROVINCES = new Set(
  'adana adiyaman afyonkarahisar afyon agri aksaray amasya ankara antalya ardahan artvin aydin balikesir bartin batman bayburt bilecik bingol bitlis bolu burdur bursa canakkale cankiri corum denizli diyarbakir duzce edirne elazig erzincan erzurum eskisehir gaziantep giresun gumushane hakkari hatay igdir isparta istanbul izmir kahramanmaras karabuk karaman kars kastamonu kayseri kilis kirikkale kirklareli kirsehir kocaeli konya kutahya malatya manisa mardin mersin mugla mus nevsehir nigde ordu osmaniye rize sakarya samsun sanliurfa siirt sinop sirnak sivas tekirdag tokat trabzon tunceli usak van yalova yozgat zonguldak'.split(
    ' ',
  ),
);
const TURKEY_WORDS = new Set(['turkiye', 'turkey']);
const FOREIGN_PLACES = new Set(
  'germany deutschland almanya netherlands hollanda nederland england ingiltere scotland ireland irlanda france fransa spain ispanya italy italya portugal portekiz poland polonya sweden isvec norway norvec denmark danimarka finland finlandiya switzerland isvicre austria avusturya belgium belcika czechia romania romanya bulgaria bulgaristan greece yunanistan estonia estonya latvia lithuania hungary macaristan serbia cyprus kibris malta luxembourg georgia azerbaijan azerbaycan kazakhstan qatar katar kuwait bahrain oman usa canada kanada mexico brazil india singapore japan australia berlin munich munchen hamburg frankfurt cologne koln stuttgart dusseldorf amsterdam rotterdam eindhoven utrecht london manchester edinburgh dublin paris lyon madrid barcelona valencia milan rome lisbon porto stockholm gothenburg copenhagen oslo helsinki zurich geneva vienna warsaw krakow wroclaw prague brno bucharest sofia athens tallinn riga vilnius budapest belgrade nicosia tbilisi baku almaty doha riyadh jeddah dubai toronto vancouver montreal sydney melbourne'.split(
    ' ',
  ),
);
const FOREIGN_PHRASES = ['united kingdom', 'united states', 'new york', 'san francisco', 'abu dhabi', 'saudi arabia', 'suudi arabistan', 'czech republic', 'new zealand'];

export type WorkScope = 'local' | 'remote' | 'abroad' | 'unknown';

export function isInTurkey(text: string | null | undefined): boolean {
  const tokens = fold(text).split(' ');
  return !!detectLocation(text).district || tokens.some((t) => TURKISH_PROVINCES.has(t) || TURKEY_WORDS.has(t));
}

function isAbroad(text: string | null | undefined): boolean {
  const f = ` ${fold(text)} `;
  return f.split(' ').some((t) => FOREIGN_PLACES.has(t)) || FOREIGN_PHRASES.some((p) => f.includes(` ${p} `));
}

/**
 * İlanın kapsamı: uzaktan mı, Türkiye'de bir yerde mi, yurt dışında mı. Tanınmayan ya da yazılmamış konum
 * "unknown" kalır; yurt dışı ancak bilinen bir ülke ya da şehir adı geçiyorsa söylenir.
 */
/** İstanbul'da olduğu bilinen ama ilçesi (yakası) yazmayan konumların filtre etiketi; yalnızca bir yaka seçiliyken kullanılır. */
export const ISTANBUL_UNSPECIFIED_SIDE = 'İstanbul (yaka belirsiz)';

const isIstanbulSide = (selection: string) => (Object.values(ISTANBUL_SIDE_LABELS) as string[]).includes(selection);

function selectionRules(selection: string): RegionRules | null {
  const region = regionForSelection(selection);
  if (!region.city) return null;
  const wholeIstanbul = fold(selection) === 'istanbul';
  const districtsPrimary = wholeIstanbul ? [...region.districtsPrimary, ...ISTANBUL_DISTRICTS.map((d) => d.name)] : region.districtsPrimary;
  return { city: region.city, districtsPrimary, districtsConditional: [], allowRemote: false, allowHybrid: true };
}

/**
 * Konum metninin düştüğü arama seçimleri (ör. "İstanbul (Avrupa Yakası)", "Kocaeli"). Her seçim ayrı değerlendirilir,
 * böylece yakalar birbirinden ayrı filtrelenebilir. Yaka seçiliyken ilçesiz bir İstanbul konumu ISTANBUL_UNSPECIFIED_SIDE döner.
 */
export function selectionsMatching(selections: string[], text: string | null | undefined): string[] {
  const value = text?.trim();
  if (!value) return [];
  const matched = selections.filter((selection) => {
    const rules = selectionRules(selection);
    return !!rules && evaluateLocation(rules, value) === 'primary';
  });
  if (matched.length) return matched;
  if (!selections.some(isIstanbulSide) || selections.some((s) => fold(s) === 'istanbul')) return [];
  const location = detectLocation(value);
  return location.city === 'İstanbul' && !location.district ? [ISTANBUL_UNSPECIFIED_SIDE] : [];
}

/** Profildeki şehir seçimleri, filtre çiplerinin sırasıyla; yaka seçiliyse "yaka belirsiz" de eklenir. */
export function regionFilterLabels(selections: string[]): string[] {
  const labels = [...selections];
  if (selections.some(isIstanbulSide) && !selections.some((s) => fold(s) === 'istanbul')) labels.push(ISTANBUL_UNSPECIFIED_SIDE);
  return labels;
}

export function workScopeOf(locationText: string | null | undefined, workMode?: string | null): WorkScope {
  if (workMode === 'remote' || detectLocation(locationText).remote) return 'remote';
  if (isInTurkey(locationText)) return 'local';
  return isAbroad(locationText) ? 'abroad' : 'unknown';
}
