// Bluetooth Thermal Printer Service & ESC/POS / TSPL Encoder
// Supports:
// 1. Native Android Bluetooth Classic (SPP RFCOMM) via window.AndroidBluetoothBridge
// 2. Web Bluetooth (BLE) via navigator.bluetooth for Chrome / Edge browsers
// 3. Manual Paper Width (mm) & Paper Height (mm) + high-speed streaming

export type PrinterProtocol = "escpos" | "tspl";
export type PrintQualitySpeed = "normal" | "fast";

export type PrintPaperOptions = {
  paperWidthMm: number;
  paperHeightMm: number;
  threshold?: number;
  speedMode?: PrintQualitySpeed;
};

export type BluetoothPrinterDevice = {
  id: string; // MAC address on Android or BLE device.id on Web
  name: string;
  address: string;
  bonded?: boolean;
  source: "android" | "web";
};

/**
 * Converts manual Paper Width & Height (mm) to 203 DPI (8 dots/mm) printable dot bounds.
 * Standard 58mm roll printers have 48mm (384 dots) printheads; 80mm rolls have 72mm (576 dots).
 */
export function getPrintableAreaDots(
  paperWidthMm: number,
  paperHeightMm: number,
  protocol: PrinterProtocol,
): { widthDots: number; heightDots: number; marginLeftDots: number; marginTopDots: number } {
  const safeW = Math.max(20, Math.min(120, Number(paperWidthMm) || 80));
  const safeH = Math.max(20, Math.min(300, Number(paperHeightMm) || 120));

  if (protocol === "tspl") {
    // 1.5mm safe margin around sticker edge
    const rawW = Math.max(128, Math.round((safeW - 3) * 8));
    const widthDots = Math.floor(rawW / 8) * 8;
    const heightDots = Math.max(64, Math.round((safeH - 3) * 8));
    return {
      widthDots,
      heightDots,
      marginLeftDots: 12,
      marginTopDots: 12,
    };
  }

  // ESC/POS printable width mapping
  let rawW: number;
  if (safeW >= 56 && safeW <= 60) {
    rawW = 384; // standard 58mm paper -> 48mm printhead
  } else if (safeW >= 78 && safeW <= 82) {
    rawW = 576; // standard 80mm paper -> 72mm printhead
  } else {
    rawW = Math.max(128, Math.round(safeW * 8));
  }
  const widthDots = Math.floor(rawW / 8) * 8;
  const heightDots = Math.max(64, Math.round(safeH * 8));

  return {
    widthDots,
    heightDots,
    marginLeftDots: 0,
    marginTopDots: 0,
  };
}

/**
 * Trims outer pure-white margins of a canvas, then proportionally fits the content
 * inside (targetWidthDots x maxHeightDots) so it never overflows onto extra labels.
 */
function prepareThermalCanvas(
  sourceCanvas: HTMLCanvasElement,
  targetWidthDots: number,
  maxHeightDots: number,
  trimMargins = true,
): HTMLCanvasElement {
  let sx = 0;
  let sy = 0;
  let sw = sourceCanvas.width;
  let sh = sourceCanvas.height;

  if (trimMargins && sw > 20 && sh > 20) {
    const sctx = sourceCanvas.getContext("2d");
    if (sctx) {
      const img = sctx.getImageData(0, 0, sw, sh);
      const data = img.data;
      let minX = sw;
      let minY = sh;
      let maxX = -1;
      let maxY = -1;

      for (let y = 0; y < sh; y += 4) {
        for (let x = 0; x < sw; x += 4) {
          const i = (y * sw + x) * 4;
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          if (lum < 245 && data[i + 3] > 20) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (maxX > minX && maxY > minY) {
        const pad = 12;
        sx = Math.max(0, minX - pad);
        sy = Math.max(0, minY - pad);
        sw = Math.min(sourceCanvas.width - sx, maxX - sx + pad * 2);
        sh = Math.min(sourceCanvas.height - sy, maxY - sy + pad * 2);
      }
    }
  }

  // Fit proportionally within manual paper width & height bounds
  const scale = Math.min(targetWidthDots / sw, maxHeightDots / sh);
  const drawW = Math.max(8, Math.round(sw * scale));
  const drawH = Math.max(8, Math.round(sh * scale));
  const offsetX = Math.max(0, Math.floor((targetWidthDots - drawW) / 2));

  // Align canvas byte width cleanly and match actual drawn height (no wasted blank paper feed)
  const outWidth = Math.floor(targetWidthDots / 8) * 8;
  const out = document.createElement("canvas");
  out.width = outWidth;
  out.height = drawH;

  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sourceCanvas, sx, sy, sw, sh, offsetX, 0, drawW, drawH);

  return out;
}

/**
 * Encodes an HTMLCanvasElement into ESC/POS raster graphics (GS v 0) bytes.
 * Skips tall empty white gaps via fast ESC J feeds and streams continuous ink bands.
 */
export function encodeCanvasToEscPos(
  sourceCanvas: HTMLCanvasElement,
  opts: PrintPaperOptions,
): Uint8Array {
  const area = getPrintableAreaDots(opts.paperWidthMm, opts.paperHeightMm, "escpos");
  const isFast = opts.speedMode === "fast";
  const threshold = opts.threshold ?? 175;

  // In fast mode (m=3, double-width & double-height), send 1/2 width & 1/2 height -> 4x smaller payload
  const targetW = isFast ? Math.floor(area.widthDots / 2 / 8) * 8 : area.widthDots;
  const maxH = isFast ? Math.floor(area.heightDots / 2) : area.heightDots;

  const canvas = prepareThermalCanvas(sourceCanvas, targetW, maxH, true);
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const imgData = ctx.getImageData(0, 0, width, height).data;

  const bytesPerRow = Math.ceil(width / 8);
  const xL = bytesPerRow & 0xff;
  const xH = (bytesPerRow >> 8) & 0xff;

  // Pack all pixel rows once and track which rows contain any black dot
  const fullRaster = new Uint8Array(bytesPerRow * height);
  const rowHasInk = new Uint8Array(height);

  for (let y = 0; y < height; y++) {
    let anyInk = 0;
    const rowBase = y * bytesPerRow;
    const pxRowBase = y * width;
    for (let bx = 0; bx < bytesPerRow; bx++) {
      let byte = 0;
      const xBase = bx * 8;
      for (let bit = 0; bit < 8; bit++) {
        const x = xBase + bit;
        if (x < width) {
          const idx = (pxRowBase + x) * 4;
          const lum = 0.299 * imgData[idx] + 0.587 * imgData[idx + 1] + 0.114 * imgData[idx + 2];
          if (lum < threshold) {
            byte |= 1 << (7 - bit);
          }
        }
      }
      if (byte !== 0) anyInk = 1;
      fullRaster[rowBase + bx] = byte;
    }
    rowHasInk[y] = anyInk;
  }

  const chunks: Uint8Array[] = [];
  // ESC @ (Init)
  chunks.push(new Uint8Array([0x1b, 0x40]));

  const rasterMode = isFast ? 0x03 : 0x00;
  const dotMultiplier = isFast ? 2 : 1;
  const minBlankRunToSkip = 24; // Skip blank gaps >= 24px via 3-byte ESC J feed

  let y = 0;
  while (y < height) {
    // Count consecutive blank rows starting at y
    let blankRun = 0;
    while (y + blankRun < height && rowHasInk[y + blankRun] === 0) {
      blankRun++;
    }

    if (blankRun >= minBlankRunToSkip) {
      let feedDots = blankRun * dotMultiplier;
      while (feedDots > 0) {
        const step = Math.min(255, feedDots);
        chunks.push(new Uint8Array([0x1b, 0x4a, step]));
        feedDots -= step;
      }
      y += blankRun;
      continue;
    }

    // Collect continuous ink band until either end or a long blank gap >= minBlankRunToSkip
    const bandStart = y;
    let bandEnd = y;
    while (bandEnd < height) {
      if (rowHasInk[bandEnd] === 1) {
        bandEnd++;
      } else {
        let gap = 0;
        while (bandEnd + gap < height && rowHasInk[bandEnd + gap] === 0) {
          gap++;
        }
        if (gap >= minBlankRunToSkip || bandEnd + gap >= height) {
          break;
        }
        bandEnd += gap;
      }
    }

    // Emit band in up to 2048-row GS v 0 blocks
    let segStart = bandStart;
    while (segStart < bandEnd) {
      const h = Math.min(2048, bandEnd - segStart);
      const yL = h & 0xff;
      const yH = (h >> 8) & 0xff;
      chunks.push(new Uint8Array([0x1d, 0x76, 0x30, rasterMode, xL, xH, yL, yH]));
      chunks.push(fullRaster.subarray(segStart * bytesPerRow, (segStart + h) * bytesPerRow));
      segStart += h;
    }

    y = bandEnd;
  }

  // Crisp small paper feed (3mm) at end of label without cutter stall
  chunks.push(new Uint8Array([0x1b, 0x4a, 0x18]));
  return concatUint8Arrays(chunks);
}

/**
 * Encodes an HTMLCanvasElement into TSPL BITMAP command for label printers,
 * respecting exact manual paperWidthMm x paperHeightMm and high print speed.
 */
export function encodeCanvasToTspl(
  sourceCanvas: HTMLCanvasElement,
  opts: PrintPaperOptions,
): Uint8Array {
  const safeW = Math.max(20, Math.min(120, Number(opts.paperWidthMm) || 100));
  const safeH = Math.max(20, Math.min(300, Number(opts.paperHeightMm) || 150));
  const area = getPrintableAreaDots(safeW, safeH, "tspl");
  const threshold = opts.threshold ?? 175;
  const speed = opts.speedMode === "fast" ? 6 : 4;

  const canvas = prepareThermalCanvas(sourceCanvas, area.widthDots, area.heightDots, true);
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const imgData = ctx.getImageData(0, 0, width, height).data;

  const bytesPerRow = Math.ceil(width / 8);
  const yOffset = Math.max(area.marginTopDots, Math.floor((safeH * 8 - height) / 2));

  const enc = new TextEncoder();
  const cmdStart = enc.encode(
    `SIZE ${safeW} mm,${safeH} mm\r\nGAP 2 mm,0 mm\r\nSPEED ${speed}\r\nDENSITY 8\r\nDIRECTION 1\r\nCLS\r\nBITMAP ${area.marginLeftDots},${yOffset},${bytesPerRow},${height},0,`,
  );

  const bitmap = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let bx = 0; bx < bytesPerRow; bx++) {
      let byte = 0xff; // 1 = white
      for (let bit = 0; bit < 8; bit++) {
        const x = bx * 8 + bit;
        if (x < width) {
          const idx = (y * width + x) * 4;
          const lum = 0.299 * imgData[idx] + 0.587 * imgData[idx + 1] + 0.114 * imgData[idx + 2];
          if (lum < threshold) {
            byte &= ~(1 << (7 - bit));
          }
        }
      }
      bitmap[y * bytesPerRow + bx] = byte;
    }
  }

  const cmdEnd = enc.encode(`\r\nPRINT 1,1\r\n`);
  return concatUint8Arrays([cmdStart, bitmap, cmdEnd]);
}

/**
 * Generates an ultra-fast native text Test Print (~200 bytes) that prints instantly (< 0.3s)
 * to verify connection and paper dimensions without transmitting heavy graphics.
 */
export function encodeFastTestPrint(
  printerName: string,
  protocol: PrinterProtocol,
  paperWidthMm: number,
  paperHeightMm: number,
): Uint8Array {
  const safeW = Math.max(20, Math.min(120, Number(paperWidthMm) || 80));
  const safeH = Math.max(20, Math.min(300, Number(paperHeightMm) || 120));
  const enc = new TextEncoder();

  if (protocol === "tspl") {
    const maxW = Math.max(100, safeW * 8 - 16);
    const maxH = Math.max(100, safeH * 8 - 16);
    const tspl =
      `SIZE ${safeW} mm,${safeH} mm\r\n` +
      `GAP 2 mm,0 mm\r\n` +
      `SPEED 5\r\n` +
      `DENSITY 8\r\n` +
      `DIRECTION 1\r\n` +
      `CLS\r\n` +
      `BOX 16,16,${maxW},${maxH},3\r\n` +
      `TEXT 36,40,"3",0,1,1,"RESI SCANNER OK"\r\n` +
      `TEXT 36,80,"2",0,1,1,"Printer: ${printerName.slice(0, 22)}"\r\n` +
      `TEXT 36,115,"2",0,1,1,"Kertas : ${safeW} x ${safeH} mm"\r\n` +
      `TEXT 36,150,"2",0,1,1,"Mode   : TSPL (Cepat)"\r\n` +
      `PRINT 1,1\r\n`;
    return enc.encode(tspl);
  }

  // Native ESC/POS text test print (instant, ~200 bytes)
  const sep = safeW <= 60 ? "--------------------------------\n" : "------------------------------------------\n";
  const textBody =
    `RESI SCANNER - TEST PRINT\n` +
    sep +
    `Printer : ${printerName.slice(0, 26)}\n` +
    `Kertas  : ${safeW}mm x ${safeH}mm\n` +
    `Mode    : ESC/POS (Siap Cetak)\n` +
    sep +
    `\n\n`;

  return concatUint8Arrays([
    new Uint8Array([0x1b, 0x40, 0x1b, 0x61, 0x01, 0x1b, 0x45, 0x01]), // Init, center, bold
    enc.encode("TEST PRINT BERHASIL\n"),
    new Uint8Array([0x1b, 0x45, 0x00, 0x1b, 0x61, 0x00]), // Normal, left align
    enc.encode(textBody),
    new Uint8Array([0x1d, 0x56, 0x42, 0x00]), // Partial cut
  ]);
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

// =========================================================================
// Bluetooth Transport Abstraction (Android Native Bridge + Web Bluetooth BLE)
// =========================================================================

type AndroidBluetoothBridge = {
  isAvailable?: () => boolean;
  getPairedDevices?: () => string;
  startDiscovery?: () => boolean;
  stopDiscovery?: () => void;
  connect?: (address: string) => void;
  disconnect?: () => void;
  isConnected?: () => boolean;
  getConnectedAddress?: () => string;
  getConnectedName?: () => string;
  printBase64?: (base64Bytes: string) => void;
  printImageBase64?: (base64Png: string, title: string) => void;
};

function getAndroidBridge(): AndroidBluetoothBridge | null {
  if (typeof window === "undefined") return null;
  return ((window as any).AndroidBluetoothBridge as AndroidBluetoothBridge) ?? null;
}

export function isAndroidNativeBluetoothAvailable(): boolean {
  const bridge = getAndroidBridge();
  return Boolean(bridge && (bridge.isAvailable ? bridge.isAvailable() : true));
}

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== "undefined" && Boolean((navigator as any).bluetooth);
}

// Common BLE GATT thermal printer service UUIDs
const BLE_PRINTER_SERVICES = [
  "000018f0-0000-1000-8000-00805f9b34fb",
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455",
  "0000ff00-0000-1000-8000-00805f9b34fb",
  "0000ffe0-0000-1000-8000-00805f9b34fb",
  "0000ae30-0000-1000-8000-00805f9b34fb",
  "0000ae00-0000-1000-8000-00805f9b34fb",
  "0000af30-0000-1000-8000-00805f9b34fb",
  "0000fff0-0000-1000-8000-00805f9b34fb",
  "0000fee7-0000-1000-8000-00805f9b34fb",
  "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f",
];

// Known print-data characteristic UUID prefixes (prioritized over config/meta chars)
const PREFERRED_PRINT_CHAR_PREFIXES = [
  "00002af1",
  "bef8d6c9",
  "49535343-8841",
  "0000ffe1",
  "0000ff02",
  "0000ae01",
  "0000af01",
  "0000fff2",
];

type BleGlobalState = {
  device: any | null;
  characteristic: any | null;
  printerInfo: BluetoothPrinterDevice | null;
  safeMtu: number;
  reconnecting: boolean;
  onDisconnectedCallback?: (() => void) | null;
};

function getBleState(): BleGlobalState {
  if (typeof window === "undefined") {
    return { device: null, characteristic: null, printerInfo: null, safeMtu: 64, reconnecting: false };
  }
  const win = window as any;
  if (!win.__resiBleState) {
    win.__resiBleState = {
      device: null,
      characteristic: null,
      printerInfo: null,
      safeMtu: 64,
      reconnecting: false,
      onDisconnectedCallback: null,
    } satisfies BleGlobalState;
  }
  return win.__resiBleState as BleGlobalState;
}

export function setWebBluetoothDisconnectListener(cb: (() => void) | null): void {
  const state = getBleState();
  state.onDisconnectedCallback = cb;
}

export function getActiveWebBluetoothPrinter(): BluetoothPrinterDevice | null {
  const state = getBleState();
  if (state.device && state.printerInfo) {
    return state.printerInfo;
  }
  return null;
}

async function findWritableBleCharacteristic(server: any): Promise<any | null> {
  const services = await server.getPrimaryServices();
  const candidates: any[] = [];

  for (const svc of services) {
    try {
      const chars = await svc.getCharacteristics();
      for (const ch of chars) {
        if (ch.properties?.writeWithoutResponse || ch.properties?.write) {
          candidates.push(ch);
        }
      }
    } catch {
      // Ignore inaccessible GATT services
    }
  }

  if (candidates.length === 0) return null;

  // 1. Prioritize known thermal printer data characteristic UUIDs
  for (const prefix of PREFERRED_PRINT_CHAR_PREFIXES) {
    const match = candidates.find((c) => String(c.uuid || "").toLowerCase().startsWith(prefix));
    if (match) return match;
  }

  // 2. Otherwise prefer writeWithoutResponse for smoother streaming, else write
  return candidates.find((c) => c.properties?.writeWithoutResponse) ?? candidates[0];
}

export function getPairedAndroidPrinters(): BluetoothPrinterDevice[] {
  const bridge = getAndroidBridge();
  if (!bridge?.getPairedDevices) return [];
  try {
    const raw = bridge.getPairedDevices();
    const list = JSON.parse(raw) as { name: string; address: string; bonded?: boolean }[];
    return list.map((d) => ({
      id: d.address,
      name: d.name || "Bluetooth Printer",
      address: d.address,
      bonded: true,
      source: "android",
    }));
  } catch {
    return [];
  }
}

export function startAndroidBluetoothScan(): boolean {
  const bridge = getAndroidBridge();
  if (!bridge?.startDiscovery) return false;
  return Boolean(bridge.startDiscovery());
}

export function stopAndroidBluetoothScan(): void {
  const bridge = getAndroidBridge();
  bridge?.stopDiscovery?.();
}

export function connectAndroidBluetoothPrinter(address: string): void {
  const bridge = getAndroidBridge();
  bridge?.connect?.(address);
}

export function disconnectBluetoothPrinter(): void {
  const bridge = getAndroidBridge();
  if (bridge?.disconnect) {
    bridge.disconnect();
  }
  const state = getBleState();
  if (state.device?.gatt?.connected) {
    try {
      state.device.gatt.disconnect();
    } catch {}
  }
  state.device = null;
  state.characteristic = null;
  state.printerInfo = null;
}

export async function requestAndConnectWebBluetoothPrinter(): Promise<BluetoothPrinterDevice> {
  const nav = navigator as any;
  if (!nav?.bluetooth) {
    throw new Error("Browser ini tidak mendukung Web Bluetooth. Gunakan Chrome/Edge atau aplikasi Android.");
  }

  const device = await nav.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: BLE_PRINTER_SERVICES,
  });

  const server = await device.gatt.connect();
  const writableChar = await findWritableBleCharacteristic(server);

  if (!writableChar) {
    try {
      device.gatt.disconnect();
    } catch {}
    throw new Error("Perangkat Bluetooth tidak memiliki service tulis printer (BLE GATT).");
  }

  const state = getBleState();
  // Clean up previous device listener if switching printers
  if (state.device && state.device !== device && state.device.__resiDisconnectHandler) {
    try {
      state.device.removeEventListener("gattserverdisconnected", state.device.__resiDisconnectHandler);
    } catch {}
  }

  const info: BluetoothPrinterDevice = {
    id: device.id,
    name: device.name || "BLE Printer",
    address: device.id,
    source: "web",
  };

  const onGattDisconnected = () => {
    // Keep device/printerInfo in state so print can auto-reconnect if printer merely idled out,
    // only clear characteristic handle so ensureBleReady re-discovers it on reconnect.
    state.characteristic = null;
  };
  if (!device.__resiDisconnectHandler) {
    device.__resiDisconnectHandler = onGattDisconnected;
    device.addEventListener("gattserverdisconnected", onGattDisconnected);
  }

  state.device = device;
  state.characteristic = writableChar;
  state.printerInfo = info;
  state.safeMtu = 64;

  return info;
}

async function ensureBleReady(preferredPrinterId?: string): Promise<BleGlobalState | null> {
  const state = getBleState();
  const nav = typeof navigator !== "undefined" ? (navigator as any) : null;

  // Attempt recovery via Web Bluetooth getDevices() if module/window state was lost
  if (!state.device && preferredPrinterId && nav?.bluetooth?.getDevices) {
    try {
      const known: any[] = await nav.bluetooth.getDevices();
      const found = known.find((d) => d.id === preferredPrinterId);
      if (found) {
        state.device = found;
      }
    } catch {}
  }

  if (!state.device) return null;

  if (!state.device.gatt?.connected || !state.characteristic) {
    state.reconnecting = true;
    try {
      const server = await state.device.gatt.connect();
      const ch = await findWritableBleCharacteristic(server);
      if (!ch) {
        throw new Error("Service tulis printer BLE tidak ditemukan saat menyambung ulang.");
      }
      state.characteristic = ch;
    } finally {
      state.reconnecting = false;
    }
  }

  return state;
}

async function writeBleBytesWithRecovery(state: BleGlobalState, bytes: Uint8Array): Promise<void> {
  let mtu = state.safeMtu || 64;
  let delayMs = (state as any).bleDelayMs ?? 4;
  let offset = 0;
  let chunksSentSinceYield = 0;

  while (offset < bytes.length) {
    // If GATT dropped mid-stream, auto-reconnect cleanly & step down to universal 20-byte MTU + safer pacing
    if (!state.device?.gatt?.connected || !state.characteristic) {
      mtu = 20;
      delayMs = 10;
      state.safeMtu = 20;
      (state as any).bleDelayMs = 10;
      const server = await state.device.gatt.connect();
      const ch = await findWritableBleCharacteristic(server);
      if (!ch) throw new Error("Koneksi BLE terputus di tengah cetak.");
      state.characteristic = ch;
    }

    const ch = state.characteristic;
    const chunk = bytes.slice(offset, offset + mtu);

    try {
      if (ch.properties?.writeWithoutResponse) {
        await ch.writeValueWithoutResponse(chunk);
        chunksSentSinceYield++;
        if (chunksSentSinceYield >= 2) {
          chunksSentSinceYield = 0;
          await new Promise((r) => setTimeout(r, delayMs));
        }
      } else {
        await ch.writeValueWithResponse(chunk);
      }
      offset += chunk.length;
    } catch (err) {
      if (mtu > 20 || delayMs < 10) {
        // Shrink MTU to guaranteed 20-byte BLE ATT limit with safer delay and retry same offset
        mtu = 20;
        delayMs = 10;
        state.safeMtu = 20;
        (state as any).bleDelayMs = 10;
        await new Promise((r) => setTimeout(r, 30));
      } else {
        throw err;
      }
    }
  }
}

export async function sendBytesToConnectedPrinter(
  bytes: Uint8Array,
  preferredPrinterId?: string,
): Promise<void> {
  const bridge = getAndroidBridge();

  // 1. Native Android Bluetooth Classic SPP path
  if (bridge && (bridge.isAvailable ? bridge.isAvailable() : true)) {
    if (!bridge.isConnected?.() && preferredPrinterId && bridge.connect) {
      // Auto-reconnect Android SPP socket transparently before printing
      await new Promise<void>((resolve, reject) => {
        const prevConn = (window as any).onAndroidBluetoothConnected;
        const prevErr = (window as any).onAndroidBluetoothError;
        const timer = setTimeout(() => {
          (window as any).onAndroidBluetoothConnected = prevConn;
          (window as any).onAndroidBluetoothError = prevErr;
          reject(new Error("Gagal menyambung ulang ke printer Bluetooth."));
        }, 7000);

        (window as any).onAndroidBluetoothConnected = (info: any) => {
          clearTimeout(timer);
          (window as any).onAndroidBluetoothConnected = prevConn;
          (window as any).onAndroidBluetoothError = prevErr;
          prevConn?.(info);
          resolve();
        };
        (window as any).onAndroidBluetoothError = (msg: string) => {
          clearTimeout(timer);
          (window as any).onAndroidBluetoothConnected = prevConn;
          (window as any).onAndroidBluetoothError = prevErr;
          reject(new Error(msg || "Gagal menyambung ke printer Bluetooth."));
        };

        bridge.connect!(preferredPrinterId);
      });
    }

    if (bridge.isConnected?.() && bridge.printBase64) {
      const b64 = uint8ToBase64(bytes);
      await new Promise<void>((resolve, reject) => {
        const prevHandler = (window as any).onAndroidBluetoothPrintDone;
        const timer = setTimeout(() => {
          (window as any).onAndroidBluetoothPrintDone = prevHandler;
          reject(new Error("Waktu tunggu cetak Bluetooth habis (timeout)."));
        }, 45000);

        (window as any).onAndroidBluetoothPrintDone = (ok: boolean, errMsg: string) => {
          clearTimeout(timer);
          (window as any).onAndroidBluetoothPrintDone = prevHandler;
          if (ok) resolve();
          else reject(new Error(errMsg || "Gagal mengirim data ke printer Bluetooth."));
        };

        bridge.printBase64!(b64);
      });
      return;
    }
  }

  // 2. Web Bluetooth BLE path (with automatic idle reconnect & MTU recovery)
  const bleState = await ensureBleReady(preferredPrinterId);
  if (bleState?.characteristic && bleState.device?.gatt?.connected) {
    await writeBleBytesWithRecovery(bleState, bytes);
    return;
  }

  getBleState().onDisconnectedCallback?.();
  throw new Error("Koneksi printer Bluetooth terputus. Silakan klik Hubungkan ulang.");
}

export function triggerAndroidSystemPrint(canvas: HTMLCanvasElement, title: string): boolean {
  const bridge = getAndroidBridge();
  if (!bridge?.printImageBase64) return false;
  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.split(",")[1] || "";
  bridge.printImageBase64(base64, title);
  return true;
}
