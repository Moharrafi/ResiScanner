// Browser/WebView PDF page-to-image renderer with caching & dynamic blank-space category stamp.
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

function detectLabelInkBounds(canvas: HTMLCanvasElement): {
  inkMinX: number;
  inkMinY: number;
  inkMaxX: number;
  inkMaxY: number;
  imgData: Uint8ClampedArray;
} {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d")!;
  const imgData = ctx.getImageData(0, 0, w, h).data;

  let inkMinX = w;
  let inkMinY = h;
  let inkMaxX = 0;
  let inkMaxY = 0;

  for (let y = 0; y < h; y += 4) {
    const rowOff = y * w;
    for (let x = 0; x < w; x += 4) {
      const i = (rowOff + x) * 4;
      const lum = 0.299 * imgData[i] + 0.587 * imgData[i + 1] + 0.114 * imgData[i + 2];
      if (lum < 238 && imgData[i + 3] > 20) {
        if (x < inkMinX) inkMinX = x;
        if (y < inkMinY) inkMinY = y;
        if (x > inkMaxX) inkMaxX = x;
        if (y > inkMaxY) inkMaxY = y;
      }
    }
  }

  if (inkMaxX <= inkMinX + 40 || inkMaxY <= inkMinY + 40) {
    inkMinX = 0;
    inkMinY = 0;
    inkMaxX = w;
    inkMaxY = h;
  }

  return { inkMinX, inkMinY, inkMaxX, inkMaxY, imgData };
}

function measureRectInkRatio(
  imgData: Uint8ClampedArray,
  canvasW: number,
  canvasH: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): number {
  const x0 = Math.max(0, Math.floor(rx));
  const y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(canvasW, Math.ceil(rx + rw));
  const y1 = Math.min(canvasH, Math.ceil(ry + rh));
  if (x1 <= x0 || y1 <= y0) return 0;

  let total = 0;
  let dark = 0;
  for (let y = y0; y < y1; y += 3) {
    const rowOff = y * canvasW;
    for (let x = x0; x < x1; x += 3) {
      const i = (rowOff + x) * 4;
      const lum = 0.299 * imgData[i] + 0.587 * imgData[i + 1] + 0.114 * imgData[i + 2];
      if (lum < 235 && imgData[i + 3] > 20) dark++;
      total++;
    }
  }
  return total > 0 ? dark / total : 0;
}

function drawStampBox(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  boxW: number,
  boxH: number,
  fontSize: number,
): void {
  const radius = Math.max(6, Math.round(boxH * 0.16));
  const strokeW = Math.max(3, Math.round(fontSize * 0.075));

  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = strokeW;

  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, radius);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#000000";
  ctx.font = `900 ${fontSize}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + boxW / 2, y + boxH / 2 + fontSize * 0.04);
  ctx.restore();
}

/**
 * Stamps a large, bold category+weight marker into the upper-right area of the shipping label:
 * - On J&T Cargo / FastTrack: below the top barcode and above the QR box (right of route text)
 * - On J&T Express & general labels: right side of the Penerima address band above Weight/Ship,
 *   staying clear of QR/barcodes and right-edge tracking numbers. Overlapping trailing address text
 *   is masked cleanly with a crisp white-backed box for maximum legibility.
 */
export function drawCategoryMarkOnCanvas(canvas: HTMLCanvasElement, markText?: string | null): void {
  const text = (markText ?? "").trim();
  if (!text) return;

  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width < 100 || canvas.height < 100) return;

  const w = canvas.width;
  const h = canvas.height;
  const { inkMinX, inkMinY, inkMaxX, inkMaxY, imgData } = detectLabelInkBounds(canvas);
  const inkW = Math.max(100, inkMaxX - inkMinX);
  const inkH = Math.max(100, inkMaxY - inkMinY);

  // Classify courier layout so placement never touches QR codes, top barcodes, or right-edge tracking digits
  const midRightQrRatio = measureRectInkRatio(
    imgData,
    w,
    h,
    inkMinX + inkW * 0.65,
    inkMinY + inkH * 0.40,
    inkW * 0.28,
    inkH * 0.14,
  );
  const topRightQrRatio = measureRectInkRatio(
    imgData,
    w,
    h,
    inkMinX + inkW * 0.66,
    inkMinY + inkH * 0.04,
    inkW * 0.26,
    inkH * 0.14,
  );
  const fullBlackBandRatio = measureRectInkRatio(
    imgData,
    w,
    h,
    inkMinX + inkW * 0.10,
    inkMinY + inkH * 0.455,
    inkW * 0.78,
    inkH * 0.035,
  );
  const rightMarginTrackRatio = measureRectInkRatio(
    imgData,
    w,
    h,
    inkMinX + inkW * 0.942,
    inkMinY + inkH * 0.18,
    inkW * 0.045,
    inkH * 0.24,
  );

  const isCargoOrFastTrack =
    midRightQrRatio > 0.14 && topRightQrRatio < 0.16 && fullBlackBandRatio < 0.55;

  // Target right edge & vertical band inside the shipping label
  const xRightFrac = isCargoOrFastTrack ? 0.964 : rightMarginTrackRatio > 0.03 ? 0.920 : 0.958;
  const yTopFrac = isCargoOrFastTrack ? 0.228 : 0.214;
  const yBotFrac = isCargoOrFastTrack ? 0.358 : 0.330;

  const bandTop = inkMinY + inkH * yTopFrac;
  const bandBot = inkMinY + inkH * yBotFrac;
  const bandH = Math.max(40, bandBot - bandTop);

  // Size stamp generously (~84% of available band height, scaled down horizontally only for long multi-item marks)
  const targetBoxH = Math.round(bandH * 0.84);
  let fontSize = Math.max(24, Math.round(targetBoxH / 1.28));
  const maxBoxW = Math.round(inkW * 0.42);

  const computeDimensions = (fs: number) => {
    ctx.font = `900 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    const measuredW = Math.ceil(ctx.measureText(text).width);
    const padX = Math.max(12, Math.round(fs * 0.32));
    const padY = Math.max(5, Math.round(fs * 0.13));
    const boxW = Math.max(measuredW + padX * 2, Math.round(fs * 1.38));
    const boxH = Math.round(fs * 1.02 + padY * 2);
    return { boxW, boxH };
  };

  let dims = computeDimensions(fontSize);
  if (dims.boxW > maxBoxW) {
    fontSize = Math.max(20, Math.round(fontSize * (maxBoxW / dims.boxW)));
    dims = computeDimensions(fontSize);
  }

  const placedX = Math.max(inkMinX + 8, Math.round(inkMinX + inkW * xRightFrac - dims.boxW));
  const placedY = Math.round(bandTop + (bandH - dims.boxH) / 2);

  drawStampBox(ctx, text, placedX, placedY, dims.boxW, dims.boxH, fontSize);
}

/**
 * Renders a single PDF page onto a fresh offscreen HTMLCanvasElement.
 */
export async function renderPdfPageToCanvas(
  file: File,
  pageNumber: number,
  scale = 2.0,
  stampMark?: string | null,
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
  if (stampMark) drawCategoryMarkOnCanvas(canvas, stampMark);
  return canvas;
}

/**
 * Renders a PDF page sized cleanly for a target thermal dot width (e.g. 384/576/800 dots).
 * Avoids over-rendering huge A4 RGBA canvases while keeping barcodes crisp.
 */
export async function renderPdfPageForThermal(
  file: File,
  pageNumber: number,
  targetWidthDots: number,
  stampMark?: string | null,
): Promise<HTMLCanvasElement> {
  const pdf = await getPdfDocument(file);
  const safePage = Math.max(1, Math.min(pageNumber, pdf.numPages));
  const page = await pdf.getPage(safePage);

  const baseViewport = page.getViewport({ scale: 1 });
  // Render slightly above target dots (1.25x) for crisp downsampling without 3M-pixel bloat
  const idealScale = (Math.max(384, targetWidthDots) * 1.25) / Math.max(1, baseViewport.width);
  const scale = Math.max(1.1, Math.min(2.4, idealScale));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport }).promise;
  if (stampMark) drawCategoryMarkOnCanvas(canvas, stampMark);
  return canvas;
}

/**
 * Renders a single PDF page to a PNG data URL.
 */
export async function renderPdfPageToDataUrl(
  file: File,
  pageNumber: number,
  scale = 1.6,
  stampMark?: string | null,
): Promise<string> {
  const canvas = await renderPdfPageToCanvas(file, pageNumber, scale, stampMark);
  return canvas.toDataURL("image/png");
}
