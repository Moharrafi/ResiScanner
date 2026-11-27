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

export type StampPositionMode = "top" | "inside";

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
  ctx.fillText(text, x + boxW / 2, y + boxH / 2 + strokeW * 0.2);
  ctx.restore();
}

/**
 * Prepends a clean external header band directly above the entire shipping label (outside any box/barcode)
 * and renders a large, ultra-clear warehouse category stamp centered above the barcode.
 */
function buildOuterTopStampedCanvas(
  sourceCanvas: HTMLCanvasElement,
  markText: string,
): HTMLCanvasElement {
  const text = markText.trim();
  if (!text || sourceCanvas.width < 100 || sourceCanvas.height < 100) return sourceCanvas;

  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const { inkMinX, inkMinY, inkMaxX, inkMaxY } = detectLabelInkBounds(sourceCanvas);
  const inkW = Math.max(100, inkMaxX - inkMinX);

  const measureCtx = sourceCanvas.getContext("2d")!;
  const baseSize = Math.round(inkW * 0.118);
  const lengthAdj = text.length > 3 ? Math.max(0.62, 3.0 / text.length) : 1;
  const fontSize = Math.max(28, Math.round(baseSize * lengthAdj));
  measureCtx.font = `900 ${fontSize}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const measuredW = Math.ceil(measureCtx.measureText(text).width);

  const padX = Math.max(16, Math.round(fontSize * 0.45));
  const padY = Math.max(8, Math.round(fontSize * 0.16));
  const boxW = Math.min(inkW, Math.max(measuredW + padX * 2, Math.round(fontSize * 1.55)));
  const boxH = Math.round(fontSize * 1.02 + padY * 2);

  const topMargin = Math.max(8, Math.round(inkW * 0.015));
  const gapToReceipt = Math.max(10, Math.round(inkW * 0.022));
  const headerBandH = topMargin + boxH + gapToReceipt;

  // Trim excess empty bottom margin so overall height stays balanced while keeping every line of the receipt
  const srcStartY = Math.max(0, inkMinY - 4);
  const bottomPad = Math.max(12, Math.round(inkW * 0.025));
  const srcEndY = Math.min(h, inkMaxY + bottomPad);
  const bodyH = Math.max(40, srcEndY - srcStartY);

  const out = document.createElement("canvas");
  out.width = w;
  out.height = headerBandH + bodyH;

  const ctx = out.getContext("2d");
  if (!ctx) return sourceCanvas;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);

  // Copy receipt below the external header band
  ctx.drawImage(sourceCanvas, 0, srcStartY, w, bodyH, 0, headerBandH, w, bodyH);

  // Center large bold stamp cleanly above the outer border / barcode
  const stampX = Math.round(inkMinX + (inkW - boxW) / 2);
  const stampY = topMargin;
  drawStampBox(ctx, text, stampX, stampY, boxW, boxH, fontSize);

  return out;
}

/**
 * Finds a clean ink-free empty box inside the shipping label bounds (avoiding QR/barcode boxes),
 * prioritizing open white regions (COD row, product table right column), and stamps bold category text.
 */
export function drawCategoryMarkOnCanvas(canvas: HTMLCanvasElement, markText?: string | null): void {
  const text = (markText ?? "").trim();
  if (!text) return;

  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width < 100 || canvas.height < 100) return;

  const w = canvas.width;
  const h = canvas.height;
  const { inkMinX, inkMinY, inkMaxX, inkMaxY, imgData } = detectLabelInkBounds(canvas);
  const inkW = inkMaxX - inkMinX;
  const inkH = inkMaxY - inkMinY;

  // Build 4px-cell Summed-Area Table of occupied (non-white) pixels for O(1) collision checks
  const cell = 4;
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const sat = new Int32Array((cols + 1) * (rows + 1));

  for (let gy = 0; gy < rows; gy++) {
    const pyStart = gy * cell;
    const pyEnd = Math.min(h, pyStart + cell);
    let rowRunningSum = 0;
    for (let gx = 0; gx < cols; gx++) {
      const pxStart = gx * cell;
      const pxEnd = Math.min(w, pxStart + cell);
      let occupied = 0;
      outer: for (let py = pyStart; py < pyEnd; py++) {
        const base = py * w;
        for (let px = pxStart; px < pxEnd; px++) {
          const i = (base + px) * 4;
          const lum = 0.299 * imgData[i] + 0.587 * imgData[i + 1] + 0.114 * imgData[i + 2];
          if (lum < 235 && imgData[i + 3] > 20) {
            occupied = 1;
            break outer;
          }
        }
      }
      rowRunningSum += occupied;
      sat[(gy + 1) * (cols + 1) + (gx + 1)] = sat[gy * (cols + 1) + (gx + 1)] + rowRunningSum;
    }
  }

  const getInkCount = (x0: number, y0: number, rw: number, rh: number): { sum: number; total: number } => {
    const gx0 = Math.max(0, Math.floor(x0 / cell));
    const gy0 = Math.max(0, Math.floor(y0 / cell));
    const gx1 = Math.min(cols, Math.ceil((x0 + rw) / cell));
    const gy1 = Math.min(rows, Math.ceil((y0 + rh) / cell));
    if (gx1 <= gx0 || gy1 <= gy0) return { sum: 1, total: 1 };
    const stride = cols + 1;
    const sum =
      sat[gy1 * stride + gx1] -
      sat[gy0 * stride + gx1] -
      sat[gy1 * stride + gx0] +
      sat[gy0 * stride + gx0];
    return { sum, total: (gx1 - gx0) * (gy1 - gy0) };
  };

  const hasInkInRect = (x0: number, y0: number, rw: number, rh: number): boolean =>
    getInkCount(x0, y0, rw, rh).sum > 0;

  // Detect J&T Cargo / FastTrack layout where a QR code sits on middle-right (x: 64%-95%, y: 40%-56%)
  // Never draw inside that QR box's top quiet zone!
  const qrProbe = getInkCount(
    inkMinX + inkW * 0.64,
    inkMinY + inkH * 0.41,
    inkW * 0.30,
    inkH * 0.14,
  );
  const leftSideProbe = getInkCount(
    inkMinX + inkW * 0.10,
    inkMinY + inkH * 0.47,
    inkW * 0.40,
    inkH * 0.06,
  );
  const hasRightMidQrBox =
    qrProbe.sum / Math.max(1, qrProbe.total) > 0.14 &&
    leftSideProbe.sum / Math.max(1, leftSideProbe.total) < 0.35;

  // Measure stamp box dimensions (enlarged high-legibility lettering)
  const computeStampMetrics = (scaleFactor: number) => {
    const baseSize = Math.round(inkW * 0.095 * scaleFactor);
    const lengthAdj = text.length > 3 ? Math.max(0.66, 3.1 / text.length) : 1;
    const fontSize = Math.max(22, Math.round(baseSize * lengthAdj));
    ctx.font = `900 ${fontSize}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    const measuredW = Math.ceil(ctx.measureText(text).width);
    const padX = Math.max(12, Math.round(fontSize * 0.38));
    const padY = Math.max(5, Math.round(fontSize * 0.16));
    const boxW = Math.max(measuredW + padX * 2, Math.round(fontSize * 1.45));
    const boxH = Math.round(fontSize * 1.02 + padY * 2);
    return { fontSize, boxW, boxH };
  };

  const zones = hasRightMidQrBox
    ? [
        // J&T Cargo / FastTrack: right of COD: row (safely below QR code box)
        { x0: 0.58, x1: 0.96, y0: 0.57, y1: 0.69 },
        // Bottom-right of product table
        { x0: 0.48, x1: 0.96, y0: 0.72, y1: 0.92 },
        // Bottom margin area
        { x0: 0.05, x1: 0.95, y0: 0.85, y1: 0.98 },
      ]
    : [
        // J&T Express: right half of COD middle band
        { x0: 0.57, x1: 0.96, y0: 0.34, y1: 0.47 },
        // Bottom-right of product table
        { x0: 0.48, x1: 0.96, y0: 0.72, y1: 0.90 },
        // Left half of COD middle band
        { x0: 0.04, x1: 0.42, y0: 0.34, y1: 0.47 },
        // Any open space outside QR/barcode regions
        { x0: 0.05, x1: 0.95, y0: 0.24, y1: 0.94 },
      ];

  let placedX: number | null = null;
  let placedY: number | null = null;
  let chosen = computeStampMetrics(1);

  const scaleSteps = [1.0, 0.9, 0.8, 0.7];
  const clearance = Math.max(2, Math.round(inkW * 0.004));

  outerSearch: for (const z of zones) {
    for (const scaleTry of scaleSteps) {
      const m = computeStampMetrics(scaleTry);
      const checkW = m.boxW + clearance * 2;
      const checkH = m.boxH + clearance * 2;

      const rxStart = Math.round(inkMinX + inkW * z.x0);
      const rxEnd = Math.round(inkMinX + inkW * z.x1) - checkW;
      const ryStart = Math.round(inkMinY + inkH * z.y0);
      const ryEnd = Math.round(inkMinY + inkH * z.y1) - checkH;
      if (rxEnd < rxStart || ryEnd < ryStart) continue;

      const step = Math.max(4, Math.round(cell * 1.5));
      const centerX = Math.round((rxStart + rxEnd) / 2);
      const xCandidates: number[] = [centerX];
      for (let dx = step; centerX - dx >= rxStart || centerX + dx <= rxEnd; dx += step) {
        if (centerX + dx <= rxEnd) xCandidates.push(centerX + dx);
        if (centerX - dx >= rxStart) xCandidates.push(centerX - dx);
      }

      for (let cy = ryStart; cy <= ryEnd; cy += step) {
        for (const cx of xCandidates) {
          if (!hasInkInRect(cx, cy, checkW, checkH)) {
            placedX = cx + clearance;
            placedY = cy + clearance;
            chosen = m;
            break outerSearch;
          }
        }
      }
    }
  }

  if (placedX === null || placedY === null) {
    chosen = computeStampMetrics(0.85);
    placedX = Math.max(8, Math.round(inkMinX + inkW * 0.95 - chosen.boxW));
    placedY = Math.max(8, Math.round(inkMinY + inkH * 0.78));
  }

  drawStampBox(ctx, text, placedX, placedY, chosen.boxW, chosen.boxH, chosen.fontSize);
}

function applyStampToCanvas(
  canvas: HTMLCanvasElement,
  stampMark?: string | null,
  stampPosition: StampPositionMode = "top",
): HTMLCanvasElement {
  const text = (stampMark ?? "").trim();
  if (!text) return canvas;
  if (stampPosition === "top") {
    return buildOuterTopStampedCanvas(canvas, text);
  }
  drawCategoryMarkOnCanvas(canvas, text);
  return canvas;
}

/**
 * Renders a single PDF page onto a fresh offscreen HTMLCanvasElement.
 */
export async function renderPdfPageToCanvas(
  file: File,
  pageNumber: number,
  scale = 2.0,
  stampMark?: string | null,
  stampPosition: StampPositionMode = "top",
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
  return applyStampToCanvas(canvas, stampMark, stampPosition);
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
  stampPosition: StampPositionMode = "top",
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
  return applyStampToCanvas(canvas, stampMark, stampPosition);
}

/**
 * Renders a single PDF page to a PNG data URL.
 */
export async function renderPdfPageToDataUrl(
  file: File,
  pageNumber: number,
  scale = 1.6,
  stampMark?: string | null,
  stampPosition: StampPositionMode = "top",
): Promise<string> {
  const canvas = await renderPdfPageToCanvas(file, pageNumber, scale, stampMark, stampPosition);
  return canvas.toDataURL("image/png");
}
