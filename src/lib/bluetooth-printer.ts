// Bluetooth Thermal Printer Service & ESC/POS / TSPL Image Encoder
// Supports:
// 1. Native Android Bluetooth Classic (SPP RFCOMM) via window.AndroidBluetoothBridge
// 2. Web Bluetooth (BLE) via navigator.bluetooth for Chrome / Edge browsers

export type PaperWidthMm = 58 | 80 | 100;
export type PrinterProtocol = "escpos" | "tspl";

export type BluetoothPrinterDevice = {
  id: string; // MAC address on Android or BLE device.id on Web
  name: string;
  address: string;
  bonded?: boolean;
  source: "android" | "web";
};

export const PAPER_WIDTH_DOTS: Record<PaperWidthMm, number> = {
  58: 384,
  80: 576,
  100: 768,
};

/**
 * Trims outer pure-white margins of a canvas while preserving safe padding,
 * then scales proportionally to target thermal printer dot width.
 */
function prepareThermalCanvas(
  sourceCanvas: HTMLCanvasElement,
  targetWidth: number,
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

      // Sample every 2px for fast bounding box detection
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
        const pad = 12;
        sx = Math.max(0, minX - pad);
        sy = Math.max(0, minY - pad);
        sw = Math.min(sourceCanvas.width - sx, maxX - sx + pad * 2);
        sh = Math.min(sourceCanvas.height - sy, maxY - sy + pad * 2);
      }
    }
  }

  const ratio = targetWidth / sw;
  const targetHeight = Math.max(8, Math.round(sh * ratio));

  const out = document.createElement("canvas");
  out.width = targetWidth;
  out.height = targetHeight;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);

  return out;
}

/**
 * Encodes an HTMLCanvasElement into ESC/POS raster graphics (GS v 0) bytes,
 * sliced into 200-row strips to prevent buffer overflow on thermal printers.
 */
export function encodeCanvasToEscPos(
  sourceCanvas: HTMLCanvasElement,
  paperWidthMm: PaperWidthMm = 80,
  threshold = 175,
): Uint8Array {
  const targetWidth = PAPER_WIDTH_DOTS[paperWidthMm];
  const canvas = prepareThermalCanvas(sourceCanvas, targetWidth, true);
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const imgData = ctx.getImageData(0, 0, width, height).data;

  const bytesPerRow = Math.ceil(width / 8);
  const xL = bytesPerRow & 0xff;
  const xH = (bytesPerRow >> 8) & 0xff;

  const chunks: Uint8Array[] = [];
  // ESC @ (Initialize printer)
  chunks.push(new Uint8Array([0x1b, 0x40]));

  const stripHeight = 200;
  for (let startY = 0; startY < height; startY += stripHeight) {
    const h = Math.min(stripHeight, height - startY);
    const yL = h & 0xff;
    const yH = (h >> 8) & 0xff;

    // GS v 0 m xL xH yL yH
    const header = new Uint8Array([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
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
            // ESC/POS: 1 = black dot, 0 = white
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

  // Feed 3 lines + partial cut (ignored safely by printers without cutter)
  chunks.push(new Uint8Array([0x1b, 0x64, 0x03, 0x1d, 0x56, 0x42, 0x00]));

  return concatUint8Arrays(chunks);
}

/**
 * Encodes an HTMLCanvasElement into TSPL BITMAP command for label printers.
 * Note: TSPL BITMAP uses 0 = black dot, 1 = white background.
 */
export function encodeCanvasToTspl(
  sourceCanvas: HTMLCanvasElement,
  paperWidthMm: PaperWidthMm = 80,
  threshold = 175,
): Uint8Array {
  const targetWidth = PAPER_WIDTH_DOTS[paperWidthMm];
  const canvas = prepareThermalCanvas(sourceCanvas, targetWidth, true);
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const imgData = ctx.getImageData(0, 0, width, height).data;

  const bytesPerRow = Math.ceil(width / 8);
  // 203 DPI ≈ 8 dots/mm
  const heightMm = Math.max(20, Math.ceil(height / 8) + 2);

  const enc = new TextEncoder();
  const cmdStart = enc.encode(
    `SIZE ${paperWidthMm} mm,${heightMm} mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 1\r\nCLS\r\nBITMAP 0,0,${bytesPerRow},${height},0,`,
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
          // TSPL: clear bit (0) for black pixel
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
    // BLE safe chunk size (20 bytes works reliably across older & newer BLE printers)
    const mtu = 64;
    for (let i = 0; i < bytes.length; i += mtu) {
      const chunk = bytes.slice(i, i + mtu);
      if (activeBleCharacteristic.properties.writeWithoutResponse) {
        await activeBleCharacteristic.writeValueWithoutResponse(chunk);
      } else {
        await activeBleCharacteristic.writeValueWithResponse(chunk);
      }
      // Small delay so printer buffer doesn't drop packets
      await new Promise((r) => setTimeout(r, 12));
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
