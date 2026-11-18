import type { PDFDocumentProxy } from 'pdfjs-dist';

/** pdf.js yalnız önizleme açılınca yüklenir; ana paket büyümez. */
export async function loadPdf(data: ArrayBuffer): Promise<{ doc: PDFDocumentProxy; destroy: () => Promise<void> }> {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data });
  return { doc: await task.promise, destroy: () => task.destroy() };
}

/** Sayfayı kabın genişliğine sığdırıp ekran yoğunluğunda (retina dahil) keskin çizer. */
export async function renderPage(doc: PDFDocumentProxy, pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number) {
  const page = await doc.getPage(pageNumber);
  const fit = cssWidth / page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({ scale: fit * (window.devicePixelRatio || 1) });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport }).promise;
  page.cleanup();
}
