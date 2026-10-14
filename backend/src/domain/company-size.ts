/** Çalışan sayısı aralıkları; LinkedIn firma sayfalarındaki aralıklarla uyumludur (en üst iki aralık birleşik). */
export const EMPLOYEE_RANGES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001+'] as const;
export type EmployeeRange = (typeof EMPLOYEE_RANGES)[number];

export interface EmployeeSize {
  range: EmployeeRange;
  /** Kaynak tek bir sayı verdiyse o sayı; yalnızca aralık biliniyorsa null. */
  count: number | null;
}

const UPPER_BOUNDS: [number, EmployeeRange][] = [
  [10, '1-10'],
  [50, '11-50'],
  [200, '51-200'],
  [500, '201-500'],
  [1000, '501-1000'],
  [5000, '1001-5000'],
];
const MAX_PLAUSIBLE_EMPLOYEES = 5_000_000;
const THOUSANDS_SEPARATOR = /(\d)[.,](?=\d{3}(?!\d))/g;
const NUMBER = String.raw`(\d+(?:[.,]\d+)?)\s*(k\b|bin\b)?`;
const RANGE_PATTERN = new RegExp(`${NUMBER}\\s*(?:-|–|—|to\\b|ile\\b|ila\\b)\\s*${NUMBER}`);
const OPEN_ENDED_PATTERN = new RegExp(`${NUMBER}\\s*(?:\\+|ve üzeri|üzeri|'?den fazla|'?dan fazla|or more|and above)`);
const ANY_NUMBER = new RegExp(NUMBER, 'g');

export function isEmployeeRange(value: unknown): value is EmployeeRange {
  return typeof value === 'string' && (EMPLOYEE_RANGES as readonly string[]).includes(value);
}

export function employeeRangeOf(count: number): EmployeeRange {
  return UPPER_BOUNDS.find(([max]) => count <= max)?.[1] ?? '5001+';
}

function plausible(n: number) {
  return Number.isFinite(n) && n >= 1 && n <= MAX_PLAUSIBLE_EMPLOYEES;
}

function numberOf(digits: string, unit: string | undefined) {
  return parseFloat(digits.replace(',', '.')) * (unit ? 1000 : 1);
}

/**
 * Kaynaktaki serbest metni ("51-200", "2-10 çalışan", "1.001-5.000 employees", "10.000+", "yaklaşık 350", "1,2K")
 * aralığa çevirir. Aralıkta orta nokta, "N+" biçiminde N'nin bir fazlası esas alınır. Birden fazla ilgisiz sayı
 * içeren (ör. kuruluş yılıyla birlikte) ya da anlaşılamayan metin null döner.
 */
export function parseEmployees(input: string | number | null | undefined): EmployeeSize | null {
  if (typeof input === 'number') return plausible(input) ? { range: employeeRangeOf(input), count: Math.round(input) } : null;
  if (!input) return null;
  const text = input.toLocaleLowerCase('tr').replace(THOUSANDS_SEPARATOR, '$1');
  const range = text.match(RANGE_PATTERN);
  if (range) {
    const low = numberOf(range[1], range[2]);
    const high = numberOf(range[3], range[4]);
    return plausible(low) && plausible(high) && high >= low ? { range: employeeRangeOf((low + high) / 2), count: null } : null;
  }
  const openEnded = text.match(OPEN_ENDED_PATTERN);
  if (openEnded) {
    const floor = numberOf(openEnded[1], openEnded[2]);
    return plausible(floor) ? { range: employeeRangeOf(floor + 1), count: null } : null;
  }
  const numbers = [...text.matchAll(ANY_NUMBER)].map((m) => numberOf(m[1], m[2]));
  if (numbers.length !== 1 || !plausible(numbers[0])) return null;
  return { range: employeeRangeOf(numbers[0]), count: Math.round(numbers[0]) };
}

export function employeeSizeOf(company: { employeeRange: string | null; employeeCount: number | null }): EmployeeSize | null {
  return isEmployeeRange(company.employeeRange) ? { range: company.employeeRange, count: company.employeeCount } : null;
}
