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

      for (let y = 0; y < sh; y += 2) {
        for (let x = 0; x < sw; x += 2) {
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
        const pad = 10;
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
 * Sends as a continuous block (zero inter-strip motor pauses) and supports fast mode (m=3).
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

  const chunks: Uint8Array[] = [];
  // ESC @ (Init)
  chunks.push(new Uint8Array([0x1b, 0x40]));

  const rasterMode = isFast ? 0x03 : 0x00;
  // Use large stripHeight so standard labels print in 1 single GS v 0 command (no stepper pause)
  const stripHeight = 2048;

  for (let startY = 0; startY < height; startY += stripHeight) {
    const h = Math.min(stripHeight, height - startY);
    const yL = h & 0xff;
    const yH = (h >> 8) & 0xff;

    const header = new Uint8Array([0x1d, 0x76, 0x30, rasterMode, xL, xH, yL, yH]);
    const raster = new Uint8Array(bytesPerRow * h);

    for (let y = 0; y < h; y++) {
      const srcY = startY + y;
      for (let bx = 0; bx < bytesPerRow; bx++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = bx * 8 + bit;
          if (x < width) {
            const idx = (srcY * width + x) * 4;
            const lum = 0.299 * imgData[idx] + 0.587 * imgData[idx + 1] + 0.114 * imgData[idx + 2];
            if (lum < threshold) {
              byte |= 1 << (7 - bit);
            }
          }
        }
        raster[y * bytesPerRow + bx] = byte;
      }
    }

    chunks.push(header);
    chunks.push(raster);
  }

  // Feed 3 lines + partial cut
  chunks.push(new Uint8Array([0x1b, 0x64, 0x03, 0x1d, 0x56, 0x42, 0x00]));
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
  "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f",
];

let activeBleDevice: any = null;
let activeBleCharacteristic: any = null;

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
  if (activeBleDevice?.gatt?.connected) {
    activeBleDevice.gatt.disconnect();
  }
  activeBleDevice = null;
  activeBleCharacteristic = null;
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
  const services = await server.getPrimaryServices();

  let writableChar: any = null;
  for (const svc of services) {
    const chars = await svc.getCharacteristics();
    for (const ch of chars) {
      if (ch.properties.writeWithoutResponse || ch.properties.write) {
        writableChar = ch;
        break;
      }
    }
    if (writableChar) break;
  }

  if (!writableChar) {
    device.gatt.disconnect();
    throw new Error("Perangkat Bluetooth tidak memiliki service tulis printer (BLE GATT).");
  }

  activeBleDevice = device;
  activeBleCharacteristic = writableChar;

  return {
    id: device.id,
    name: device.name || "BLE Printer",
    address: device.id,
    source: "web",
  };
}

export async function sendBytesToConnectedPrinter(bytes: Uint8Array): Promise<void> {
  const bridge = getAndroidBridge();
  if (bridge?.isConnected && bridge.isConnected() && bridge.printBase64) {
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

  if (activeBleCharacteristic && activeBleDevice?.gatt?.connected) {
    // Try larger MTU first for faster BLE streaming, falling back to 20 bytes if rejected
    let mtu = 180;
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = bytes.slice(offset, offset + mtu);
      try {
        if (activeBleCharacteristic.properties.writeWithoutResponse) {
          await activeBleCharacteristic.writeValueWithoutResponse(chunk);
        } else {
          await activeBleCharacteristic.writeValueWithResponse(chunk);
        }
        offset += chunk.length;
        // Brief yield only every 5 packets to keep throughput high
        if (offset % (mtu * 5) === 0) {
          await new Promise((r) => setTimeout(r, 4));
        }
      } catch (err) {
        if (mtu > 20) {
          mtu = 20;
        } else {
          throw err;
        }
      }
    }
    return;
  }

  throw new Error("Belum ada printer Bluetooth yang terhubung.");
}

export function triggerAndroidSystemPrint(canvas: HTMLCanvasElement, title: string): boolean {
  const bridge = getAndroidBridge();
  if (!bridge?.printImageBase64) return false;
  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.split(",")[1] || "";
  bridge.printImageBase64(base64, title);
  return true;
}
