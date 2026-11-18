import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const run = promisify(execFile);
const TOOL_TIMEOUT_MS = 30_000;
/** Bundan küçük görseller simge ya da süs sayılır. */
const MIN_PHOTO_SIDE = 80;

export interface PdfImageRow {
  num: number;
  page: number;
  type: string;
  width: number;
  height: number;
}

/** `pdfimages -list` çıktısını satırlara çevirir. */
export function parseImageList(output: string): PdfImageRow[] {
  return output
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 5 && /^\d+$/.test(cols[0]) && /^\d+$/.test(cols[1]))
    .map(([page, num, type, width, height]) => ({ page: Number(page), num: Number(num), type, width: Number(width), height: Number(height) }));
}

/** İlk sayfadaki en büyük gerçek görsel (maske ya da küçük simge değil) fotoğraf adayıdır. */
export function photoCandidate(rows: PdfImageRow[]): PdfImageRow | null {
  const images = rows.filter((r) => r.page === 1 && r.type === 'image' && Math.min(r.width, r.height) >= MIN_PHOTO_SIDE);
  return images.sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;
}

/**
 * PDF CV'nin ilk sayfasındaki fotoğraf adayını PNG olarak çıkarır (poppler `pdfimages`). Araç yoksa ya da uygun görsel
 * bulunmazsa null döner; şablon fotoğrafsız kurulur.
 */
export async function extractCvPhoto(pdf: Buffer): Promise<{ data: Buffer; width: number; height: number } | null> {
  const dir = await mkdtemp(join(tmpdir(), 'cv-photo-'));
  try {
    const file = join(dir, 'cv.pdf');
    await writeFile(file, pdf);
    const { stdout } = await run('pdfimages', ['-list', '-f', '1', '-l', '1', file], { timeout: TOOL_TIMEOUT_MS });
    const photo = photoCandidate(parseImageList(stdout));
    if (!photo) return null;
    await run('pdfimages', ['-png', '-f', '1', '-l', '1', file, join(dir, 'img')], { timeout: TOOL_TIMEOUT_MS });
    const data = await readFile(join(dir, `img-${String(photo.num).padStart(3, '0')}.png`));
    return { data, width: photo.width, height: photo.height };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
