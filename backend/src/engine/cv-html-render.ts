import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import puppeteer, { type Browser } from 'puppeteer-core';
import { env } from '../common/env';
import { CV_FONTS, layoutFonts } from '../domain/cv-layout';

/** A4, CSS pikseliyle (96 dpi). */
const A4_WIDTH_PX = 793.7;
const A4_HEIGHT_PX = 1122.5;
/** Uzayan CV yazı küçültülerek sayfaya sığdırılır; normalde bu orana kadar, son çare olarak LAST_RESORT_MIN_SCALE'e kadar. */
export const DEFAULT_MIN_SCALE = 0.85;
export const LAST_RESORT_MIN_SCALE = 0.72;
const SCALE_STEP = 0.01;
/** Ölçüm sığıyor dese de yazdırılan PDF taşarsa ölçek bu adımlarla küçültülüp yeniden yazdırılır. */
const PRINT_RETRY_STEP = 0.02;
const PAGE_TOLERANCE_PX = 4;
const RENDER_TIMEOUT_MS = 60_000;
const FONT_SUBSETS = ['latin', 'latin-ext'];

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LINUX_CHROMIUM = '/usr/bin/chromium';

export function chromiumPath(): string | null {
  const candidates = [env().CHROMIUM_PATH, process.platform === 'darwin' ? MAC_CHROME : LINUX_CHROMIUM].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

const fontCache = new Map<string, string>();

/** Fontsource paketlerindeki Latin ve Latin Genişletilmiş (Türkçe) kesitlerini sayfaya gömülü @font-face olarak verir. */
function fontFaces(family: string): string {
  const cached = fontCache.get(family);
  if (cached !== undefined) return cached;
  const pkg = CV_FONTS[family];
  const root = dirname(require.resolve(`@fontsource/${pkg}/package.json`));
  const faces: string[] = [];
  for (const weight of [300, 400, 500, 600, 700, 800]) {
    const cssPath = join(root, `${weight}.css`);
    if (!existsSync(cssPath)) continue;
    const css = readFileSync(cssPath, 'utf8');
    for (const block of css.split(/(?=\/\* )/)) {
      const subset = FONT_SUBSETS.find((s) => block.includes(`-${s}-${weight}-normal */`));
      const range = block.match(/unicode-range:\s*([^;]+);/)?.[1];
      if (!subset || !range) continue;
      const file = join(root, 'files', `${pkg}-${subset}-${weight}-normal.woff2`);
      if (!existsSync(file)) continue;
      const data = readFileSync(file).toString('base64');
      faces.push(`@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${data}) format('woff2');unicode-range:${range};}`);
    }
  }
  const result = faces.join('\n');
  fontCache.set(family, result);
  return result;
}

const BASE_CSS = '@page{size:A4;margin:0}html,body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}';

export function documentHtml(html: string): string {
  const head = `<meta charset="utf-8"><style>${layoutFonts(html).map(fontFaces).join('\n')}\n${BASE_CSS}</style>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${head}`);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

export function pdfPageCount(pdf: Buffer): number {
  return pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g)?.length ?? 0;
}

export interface HtmlPdf {
  pdf: Buffer;
  pages: number;
  scale: number;
  /** İçerik, izin verilen en küçük ölçekte hedef sayfa sayısına sığdı mı. Sığmadıysa PDF taşmış hâliyle döner. */
  fits: boolean;
}

function scaleCandidates(minScale: number): number[] {
  const steps = Math.round((1 - minScale) / SCALE_STEP);
  return Array.from({ length: steps + 1 }, (_, i) => Math.round((1 - i * SCALE_STEP) * 100) / 100);
}

/**
 * Doldurulmuş şablonu başsız Chromium ile A4 PDF'e çevirir. Sayfa ağ erişimi olmadan açılır (yazı tipleri ve fotoğraf
 * gömülüdür). İçerik orijinalin sayfa sayısını aşarsa yazı biraz küçültülerek sığdırılır.
 */
export async function renderHtmlPdf(html: string, targetPages: number, minScale = DEFAULT_MIN_SCALE): Promise<HtmlPdf> {
  const executablePath = chromiumPath();
  if (!executablePath) throw new Error('Chromium bulunamadı');
  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none', '--disable-gpu'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);
    await page.setRequestInterception(true);
    page.on('request', (req) => (/^(data|about):/.test(req.url()) ? req.continue() : req.abort()));
    await page.emulateMediaType('print');
    await page.setContent(documentHtml(html), { waitUntil: 'load' });
    await page.evaluate('document.fonts.ready.then(() => true)');

    const pages = Math.max(1, targetPages);
    const limit = pages * A4_HEIGHT_PX + PAGE_TOLERANCE_PX;
    let scale = 1;
    let measuredFit = false;
    for (const candidate of scaleCandidates(minScale)) {
      await page.setViewport({ width: Math.round(A4_WIDTH_PX / candidate), height: Math.round(A4_HEIGHT_PX) });
      const height = Number(await page.evaluate('document.documentElement.scrollHeight'));
      scale = candidate;
      measuredFit = height * candidate <= limit;
      if (measuredFit) break;
    }
    const print = async (at: number) => Buffer.from(await page.pdf({ width: '210mm', height: '297mm', printBackground: true, scale: at, margin: { top: 0, right: 0, bottom: 0, left: 0 } }));
    let pdf = await print(scale);
    let printed = pdfPageCount(pdf);
    while (measuredFit && printed > pages && scale - PRINT_RETRY_STEP >= minScale) {
      scale = Math.round((scale - PRINT_RETRY_STEP) * 100) / 100;
      pdf = await print(scale);
      printed = pdfPageCount(pdf);
    }
    return { pdf, pages: printed, scale, fits: measuredFit && printed <= pages };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
