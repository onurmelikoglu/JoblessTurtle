/** CSV/Excel dışa aktarımında formül enjeksiyonunu engeller (=, +, -, @, tab, CR ile başlayan hücreler). */
export function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const q = (v: unknown) => {
    const s = escapeCell(v);
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(q).join(','), ...rows.map((r) => r.map(q).join(','))];
  return `﻿${lines.join('\r\n')}\r\n`;
}
