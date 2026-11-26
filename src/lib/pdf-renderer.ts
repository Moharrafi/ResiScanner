// Browser/WebView PDF page-to-image renderer with caching.
// Renders individual PDF pages to data URLs for preview and HTMLCanvasElement for thermal printing.

let pdfjsCache: any = null;

async function getPdfJs() {
  if (pdfjsCache) return pdfjsCache;
  const pdfjs: any = await import("pdfjs-dist/build/pdf.mjs");
  const workerSrc = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  pdfjsCache = pdfjs;
  return pdfjs;
}

const pdfDocCache = new WeakMap<File, Promise<any>>();

async function getPdfDocument(file: File): Promise<any> {
  let promise = pdfDocCache.get(file);
  if (!promise) {
    promise = (async () => {
      const pdfjs = await getPdfJs();
      const buf = await file.arrayBuffer();
      return pdfjs.getDocument({ data: buf }).promise;
    })();
    pdfDocCache.set(file, promise);
  }
  return promise;
}

/**
 * Renders a single PDF page onto a fresh offscreen HTMLCanvasElement.
 */
export async function renderPdfPageToCanvas(
  file: File,
  pageNumber: number,
  scale = 2.0,
): Promise<HTMLCanvasElement> {
  const pdf = await getPdfDocument(file);
  const safePage = Math.max(1, Math.min(pageNumber, pdf.numPages));
  const page = await pdf.getPage(safePage);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // White background for clean thermal label rendering
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

/**
 * Renders a single PDF page to a PNG data URL.
 */
export async function renderPdfPageToDataUrl(
  file: File,
  pageNumber: number,
  scale = 1.6,
): Promise<string> {
  const canvas = await renderPdfPageToCanvas(file, pageNumber, scale);
  return canvas.toDataURL("image/png");
}
