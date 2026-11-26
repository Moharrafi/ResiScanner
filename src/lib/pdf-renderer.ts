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

/**
 * Finds a clean ink-free white box inside the shipping label bounds using a 4px summed-area table,
 * prioritizing open zones (right of COD, product table right column, etc.), and stamps bold category text.
 */
export function drawCategoryMarkOnCanvas(canvas: HTMLCanvasElement, markText?: string | null): void {
  const text = (markText ?? "").trim();
  if (!text) return;

  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width < 100 || canvas.height < 100) return;

  const w = canvas.width;
  const h = canvas.height;
  const imgData = ctx.getImageData(0, 0, w, h).data;

  // 1. Detect label ink bounding box (ignore outer empty A4 page margins)
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

  const inkW = inkMaxX - inkMinX;
  const inkH = inkMaxY - inkMinY;

  // 2. Build 4px-cell Summed-Area Table of occupied (non-white) pixels for O(1) collision checks
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

  const hasInkInRect = (x0: number, y0: number, rw: number, rh: number): boolean => {
    const gx0 = Math.max(0, Math.floor(x0 / cell));
    const gy0 = Math.max(0, Math.floor(y0 / cell));
    const gx1 = Math.min(cols, Math.ceil((x0 + rw) / cell));
    const gy1 = Math.min(rows, Math.ceil((y0 + rh) / cell));
    if (gx1 <= gx0 || gy1 <= gy0) return true;
    const stride = cols + 1;
    const sum =
      sat[gy1 * stride + gx1] -
      sat[gy0 * stride + gx1] -
      sat[gy1 * stride + gx0] +
      sat[gy0 * stride + gx0];
    return sum > 0;
  };

  // 3. Measure stamp box dimensions (keep compact enough to fit inside COD row & product blank boxes)
  const computeStampMetrics = (scaleFactor: number) => {
    const baseSize = Math.round(inkW * 0.056 * scaleFactor);
    const lengthAdj = text.length > 3 ? Math.max(0.68, 3.2 / text.length) : 1;
    const fontSize = Math.max(16, Math.round(baseSize * lengthAdj));
    ctx.font = `900 ${fontSize}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    const measuredW = Math.ceil(ctx.measureText(text).width);
    const padX = Math.max(8, Math.round(fontSize * 0.42));
    const padY = Math.max(4, Math.round(fontSize * 0.24));
    const boxW = Math.max(measuredW + padX * 2, Math.round(fontSize * 1.45));
    const boxH = Math.round(fontSize * 1.08 + padY * 2);
    return { fontSize, boxW, boxH };
  };

  // Search zones inside label bounds in priority order
  const zones = [
    // Zone 1: Right half of COD / route middle band (exact spot highlighted by user)
    { x0: 0.57, x1: 0.96, y0: 0.34, y1: 0.47 },
    // Zone 2: Bottom-right of product table (under Seller SKU column, above Qty Total)
    { x0: 0.48, x1: 0.96, y0: 0.72, y1: 0.90 },
    // Zone 3: Upper-right / mid-right open space (FastTrack / other courier templates)
    { x0: 0.56, x1: 0.96, y0: 0.24, y1: 0.70 },
    // Zone 4: Left half of COD / middle band
    { x0: 0.04, x1: 0.42, y0: 0.34, y1: 0.47 },
    // Zone 5: Any open space inside label body
    { x0: 0.05, x1: 0.95, y0: 0.16, y1: 0.94 },
  ];

  let placedX: number | null = null;
  let placedY: number | null = null;
  let chosen = computeStampMetrics(1);

  outerSearch: for (const scaleTry of [1.0, 0.84]) {
    const m = computeStampMetrics(scaleTry);
    const clearance = Math.max(4, Math.round(inkW * 0.008));
    const checkW = m.boxW + clearance * 2;
    const checkH = m.boxH + clearance * 2;

    for (const z of zones) {
      const rxStart = Math.round(inkMinX + inkW * z.x0);
      const rxEnd = Math.round(inkMinX + inkW * z.x1) - checkW;
      const ryStart = Math.round(inkMinY + inkH * z.y0);
      const ryEnd = Math.round(inkMinY + inkH * z.y1) - checkH;
      if (rxEnd < rxStart || ryEnd < ryStart) continue;

      const step = Math.max(6, Math.round(cell * 2));
      // Center scan horizontally in zone & sweep vertically so stamp looks neatly placed
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

  // Fallback if every candidate zone has ink: anchor cleanly at bottom-right above Qty Total
  if (placedX === null || placedY === null) {
    chosen = computeStampMetrics(0.9);
    placedX = Math.max(8, Math.round(inkMinX + inkW * 0.95 - chosen.boxW));
    placedY = Math.max(8, Math.round(inkMinY + inkH * 0.78));
  }

  // 4. Draw crisp white-backed high-contrast rounded marker stamp
  const radius = Math.max(5, Math.round(chosen.boxH * 0.16));
  const strokeW = Math.max(2, Math.round(chosen.fontSize * 0.08));

  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = strokeW;

  ctx.beginPath();
  ctx.roundRect(placedX, placedY, chosen.boxW, chosen.boxH, radius);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#000000";
  ctx.font = `900 ${chosen.fontSize}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, placedX + chosen.boxW / 2, placedY + chosen.boxH / 2 + strokeW * 0.25);
  ctx.restore();
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
