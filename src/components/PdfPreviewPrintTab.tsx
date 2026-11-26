import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Bluetooth,
  BluetoothConnected,
  BluetoothSearching,
  Printer,
  Loader2,
  ZoomIn,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  SlidersHorizontal,
  Table as TableIcon,
  Image as ImageIcon,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import type { ProductCategory, ProductRow } from "@/lib/pdf-parser";
import { renderPdfPageToCanvas, renderPdfPageToDataUrl } from "@/lib/pdf-renderer";
import {
  type BluetoothPrinterDevice,
  type PrintQualitySpeed,
  type PrinterProtocol,
  connectAndroidBluetoothPrinter,
  disconnectBluetoothPrinter,
  encodeCanvasToEscPos,
  encodeCanvasToTspl,
  encodeFastTestPrint,
  getPairedAndroidPrinters,
  getPrintableAreaDots,
  isAndroidNativeBluetoothAvailable,
  isWebBluetoothAvailable,
  requestAndConnectWebBluetoothPrinter,
  sendBytesToConnectedPrinter,
  startAndroidBluetoothScan,
  stopAndroidBluetoothScan,
  triggerAndroidSystemPrint,
} from "@/lib/bluetooth-printer";

export type PdfFileEntry = {
  name: string;
  file: File;
  rows: ProductRow[];
};

type PdfPageCardData = {
  key: string;
  fileIdx: number;
  fileName: string;
  file: File;
  pageNumber: number;
  category: ProductCategory;
  items: ProductRow[];
  totalQty: number;
};

const CATEGORY_META: Record<
  ProductCategory,
  { label: string; accentBorder: string; badgeClass: string }
> = {
  hitam: {
    label: "Hitam (Biasa)",
    accentBorder: "border-l-zinc-700 dark:border-l-zinc-400",
    badgeClass:
      "border-zinc-200 bg-zinc-100 text-zinc-800 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-200",
  },
  hijau: {
    label: "Hijau",
    accentBorder: "border-l-emerald-600 dark:border-l-emerald-500",
    badgeClass:
      "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300",
  },
  bitumax: {
    label: "Bitumax",
    accentBorder: "border-l-amber-600 dark:border-l-amber-500",
    badgeClass:
      "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300",
  },
  lainnya: {
    label: "Lainnya",
    accentBorder: "border-l-muted-foreground",
    badgeClass: "border-border bg-muted text-muted-foreground",
  },
};

// Shared in-memory preview cache keyed per File instance so replaced files never collide
const previewDataUrlCache = new WeakMap<File, Map<number, string>>();

function getCachedPreviewUrl(file: File, pageNumber: number): string | null {
  return previewDataUrlCache.get(file)?.get(pageNumber) ?? null;
}

function setCachedPreviewUrl(file: File, pageNumber: number, url: string): void {
  let fileMap = previewDataUrlCache.get(file);
  if (!fileMap) {
    fileMap = new Map<number, string>();
    previewDataUrlCache.set(file, fileMap);
  }
  fileMap.set(pageNumber, url);
}

export function PdfPreviewPrintTab({
  files,
  rows,
}: {
  files: PdfFileEntry[];
  rows: ProductRow[];
}) {
  const [viewMode, setViewMode] = useState<"pdf" | "table">("pdf");
  const [selectedCategory, setSelectedCategory] = useState<"all" | ProductCategory>("all");
  const [zoomPage, setZoomPage] = useState<PdfPageCardData | null>(null);
  const [zoomImageUrl, setZoomImageUrl] = useState<string | null>(null);

  // Bluetooth Printer State
  const [isBtModalOpen, setIsBtModalOpen] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [connectingAddress, setConnectingAddress] = useState<string | null>(null);
  const [discoveredPrinters, setDiscoveredPrinters] = useState<BluetoothPrinterDevice[]>([]);
  const [connectedPrinter, setConnectedPrinter] = useState<BluetoothPrinterDevice | null>(null);

  // Printer Settings (with localStorage persistence)
  const [paperWidthInput, setPaperWidthInput] = useState<string>(() => {
    if (typeof window === "undefined") return "80";
    try {
      const saved = JSON.parse(localStorage.getItem("resi_print_settings_v1") || "{}");
      return String(saved.paperWidthMm || "80");
    } catch {
      return "80";
    }
  });
  const [paperHeightInput, setPaperHeightInput] = useState<string>(() => {
    if (typeof window === "undefined") return "120";
    try {
      const saved = JSON.parse(localStorage.getItem("resi_print_settings_v1") || "{}");
      return String(saved.paperHeightMm || "120");
    } catch {
      return "120";
    }
  });
  const [protocol, setProtocol] = useState<PrinterProtocol>(() => {
    if (typeof window === "undefined") return "escpos";
    try {
      const saved = JSON.parse(localStorage.getItem("resi_print_settings_v1") || "{}");
      return saved.protocol === "tspl" ? "tspl" : "escpos";
    } catch {
      return "escpos";
    }
  });
  const [threshold, setThreshold] = useState<number>(() => {
    if (typeof window === "undefined") return 175;
    try {
      const saved = JSON.parse(localStorage.getItem("resi_print_settings_v1") || "{}");
      return typeof saved.threshold === "number" ? saved.threshold : 175;
    } catch {
      return 175;
    }
  });
  const [speedMode, setSpeedMode] = useState<PrintQualitySpeed>(() => {
    if (typeof window === "undefined") return "normal";
    try {
      const saved = JSON.parse(localStorage.getItem("resi_print_settings_v1") || "{}");
      return saved.speedMode === "fast" ? "fast" : "normal";
    } catch {
      return "normal";
    }
  });

  const paperWidthMm = useMemo(() => {
    const n = parseFloat(paperWidthInput);
    return Number.isFinite(n) && n >= 20 ? Math.min(120, n) : 80;
  }, [paperWidthInput]);

  const paperHeightMm = useMemo(() => {
    const n = parseFloat(paperHeightInput);
    return Number.isFinite(n) && n >= 20 ? Math.min(300, n) : 120;
  }, [paperHeightInput]);

  const printAreaDots = useMemo(
    () => getPrintableAreaDots(paperWidthMm, paperHeightMm, protocol),
    [paperWidthMm, paperHeightMm, protocol],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(
        "resi_print_settings_v1",
        JSON.stringify({
          paperWidthMm,
          paperHeightMm,
          protocol,
          threshold,
          speedMode,
        }),
      );
    } catch {}
  }, [paperWidthMm, paperHeightMm, protocol, threshold, speedMode]);

  // Print Job Progress
  const [printingKey, setPrintingKey] = useState<string | null>(null);
  const [batchProgress, setBatchProgress] = useState<{
    label: string;
    current: number;
    total: number;
  } | null>(null);
  const cancelBatchRef = useRef(false);

  const isAndroidBt = useMemo(() => isAndroidNativeBluetoothAvailable(), []);
  const isWebBt = useMemo(() => isWebBluetoothAvailable(), []);

  // Build deduplicated PDF pages grouped by category
  const { pagesByCategory, orderedCategories, totalUniquePages } = useMemo(() => {
    const map = new Map<string, PdfPageCardData>();

    files.forEach((f, fileIdx) => {
      for (const r of f.rows) {
        const pageNum = r.pageNumber ?? 1;
        const cat = r.category;
        const k = `${fileIdx}::${pageNum}::${cat}`;
        if (!map.has(k)) {
          map.set(k, {
            key: k,
            fileIdx,
            fileName: f.name,
            file: f.file,
            pageNumber: pageNum,
            category: cat,
            items: [],
            totalQty: 0,
          });
        }
        const entry = map.get(k)!;
        entry.items.push(r);
        entry.totalQty += r.qty;
      }
    });

    const grouped: Record<ProductCategory, PdfPageCardData[]> = {
      hitam: [],
      hijau: [],
      bitumax: [],
      lainnya: [],
    };

    for (const p of map.values()) {
      grouped[p.category].push(p);
    }

    for (const cat of Object.keys(grouped) as ProductCategory[]) {
      grouped[cat].sort((a, b) => a.fileIdx - b.fileIdx || a.pageNumber - b.pageNumber);
    }

    const cats: ProductCategory[] = (["hitam", "hijau", "bitumax", "lainnya"] as ProductCategory[]).filter(
      (c) => grouped[c].length > 0,
    );

    return {
      pagesByCategory: grouped,
      orderedCategories: cats,
      totalUniquePages: map.size,
    };
  }, [files]);

  // Register Android Native Bluetooth Event Listeners
  useEffect(() => {
    if (typeof window === "undefined") return;
    const win = window as any;

    win.onAndroidBluetoothDeviceFound = (dev: { name: string; address: string; bonded?: boolean }) => {
      if (!dev?.address) return;
      setDiscoveredPrinters((prev) => {
        const exists = prev.some((p) => p.address === dev.address);
        if (exists) {
          return prev.map((p) =>
            p.address === dev.address
              ? { ...p, name: dev.name || p.name, bonded: dev.bonded ?? p.bonded }
              : p,
          );
        }
        return [
          ...prev,
          {
            id: dev.address,
            name: dev.name || `Bluetooth (${dev.address})`,
            address: dev.address,
            bonded: dev.bonded,
            source: "android",
          },
        ];
      });
    };

    win.onAndroidBluetoothScanFinished = () => {
      setIsScanning(false);
    };

    win.onAndroidBluetoothConnected = (info: { name: string; address: string }) => {
      setConnectingAddress(null);
      setConnectedPrinter({
        id: info.address,
        name: info.name || info.address,
        address: info.address,
        bonded: true,
        source: "android",
      });
      toast.success(`Terhubung ke printer: ${info.name || info.address}`);
    };

    win.onAndroidBluetoothDisconnected = () => {
      setConnectedPrinter(null);
      setConnectingAddress(null);
      toast.info("Koneksi printer Bluetooth terputus.");
    };

    win.onAndroidBluetoothError = (msg: string) => {
      setConnectingAddress(null);
      setIsScanning(false);
      toast.error(msg || "Terjadi kesalahan Bluetooth.");
    };

    win.onAndroidBluetoothPermissionResult = (granted: boolean) => {
      if (granted) {
        const paired = getPairedAndroidPrinters();
        if (paired.length > 0) setDiscoveredPrinters(paired);
        const started = startAndroidBluetoothScan();
        setIsScanning(started);
      } else {
        setIsScanning(false);
        toast.error("Izin Bluetooth diperlukan untuk mencari dan mencetak ke printer.");
      }
    };

    // Sync initial paired/connected state if already connected in Activity
    const bridge = win.AndroidBluetoothBridge;
    if (bridge?.isConnected?.()) {
      const addr = bridge.getConnectedAddress?.() || "";
      const name = bridge.getConnectedName?.() || addr;
      if (addr) {
        setConnectedPrinter({
          id: addr,
          name,
          address: addr,
          bonded: true,
          source: "android",
        });
      }
    }
  }, []);

  // Load high-res zoom preview when zoomPage opens
  useEffect(() => {
    if (!zoomPage) {
      setZoomImageUrl(null);
      return;
    }
    let cancelled = false;
    renderPdfPageToDataUrl(zoomPage.file, zoomPage.pageNumber, 2.2)
      .then((url) => {
        if (!cancelled) setZoomImageUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [zoomPage]);

  const handleOpenBtScanner = () => {
    setIsBtModalOpen(true);
    if (isAndroidBt) {
      const paired = getPairedAndroidPrinters();
      if (paired.length > 0) {
        setDiscoveredPrinters((prev) => {
          const map = new Map(prev.map((d) => [d.address, d]));
          for (const p of paired) map.set(p.address, p);
          return [...map.values()];
        });
      }
      const started = startAndroidBluetoothScan();
      setIsScanning(started);
    }
  };

  const handleRescanAndroid = () => {
    stopAndroidBluetoothScan();
    const paired = getPairedAndroidPrinters();
    setDiscoveredPrinters(paired);
    const started = startAndroidBluetoothScan();
    setIsScanning(started);
  };

  const handleConnectAndroid = (device: BluetoothPrinterDevice) => {
    stopAndroidBluetoothScan();
    setIsScanning(false);
    setConnectingAddress(device.address);
    connectAndroidBluetoothPrinter(device.address);
  };

  const handleConnectWebBluetooth = async () => {
    try {
      setIsScanning(true);
      const dev = await requestAndConnectWebBluetoothPrinter();
      setConnectedPrinter(dev);
      toast.success(`Terhubung ke printer: ${dev.name}`);
    } catch (err: any) {
      if (err?.name !== "NotFoundError") {
        toast.error(err?.message || "Gagal menghubungkan Web Bluetooth.");
      }
    } finally {
      setIsScanning(false);
    }
  };

  const handleDisconnectPrinter = () => {
    disconnectBluetoothPrinter();
    setConnectedPrinter(null);
  };

  const encodeCanvasForPrinter = useCallback(
    (canvas: HTMLCanvasElement) => {
      const opts = {
        paperWidthMm,
        paperHeightMm,
        threshold,
        speedMode,
      };
      return protocol === "tspl"
        ? encodeCanvasToTspl(canvas, opts)
        : encodeCanvasToEscPos(canvas, opts);
    },
    [protocol, paperWidthMm, paperHeightMm, threshold, speedMode],
  );

  const printSinglePage = async (page: PdfPageCardData) => {
    if (!connectedPrinter) {
      toast.info("Silakan cari & sambungkan printer Bluetooth terlebih dahulu.");
      handleOpenBtScanner();
      return;
    }

    setPrintingKey(page.key);
    try {
      // Render at high scale (2.5x) for crisp barcodes & small text on thermal paper
      const canvas = await renderPdfPageToCanvas(page.file, page.pageNumber, 2.5);
      const bytes = encodeCanvasForPrinter(canvas);
      await sendBytesToConnectedPrinter(bytes);
      toast.success(`Berhasil mencetak Hal. ${page.pageNumber} (${CATEGORY_META[page.category].label})`);
    } catch (err: any) {
      toast.error(err?.message || "Gagal mencetak resi ke printer Bluetooth.");
    } finally {
      setPrintingKey(null);
    }
  };

  const printCategoryBatch = async (cat: ProductCategory) => {
    const pages = pagesByCategory[cat];
    if (!pages.length) return;

    if (!connectedPrinter) {
      toast.info("Silakan cari & sambungkan printer Bluetooth terlebih dahulu.");
      handleOpenBtScanner();
      return;
    }

    cancelBatchRef.current = false;
    setBatchProgress({
      label: CATEGORY_META[cat].label,
      current: 0,
      total: pages.length,
    });

    let printed = 0;
    try {
      for (let i = 0; i < pages.length; i++) {
        if (cancelBatchRef.current) {
          toast.info(`Cetak dibatalkan (${printed}/${pages.length} resi tercetak).`);
          break;
        }
        const p = pages[i];
        setBatchProgress({
          label: CATEGORY_META[cat].label,
          current: i + 1,
          total: pages.length,
        });
        const canvas = await renderPdfPageToCanvas(p.file, p.pageNumber, 2.5);
        const bytes = encodeCanvasForPrinter(canvas);
        await sendBytesToConnectedPrinter(bytes);
        printed++;
        // Brief pause between labels so printer finishes feeding cleanly
        await new Promise((r) => setTimeout(r, 120));
      }
      if (!cancelBatchRef.current) {
        toast.success(`Selesai mencetak ${printed} resi ${CATEGORY_META[cat].label}!`);
      }
    } catch (err: any) {
      toast.error(`Berhenti di resi ke-${printed + 1}: ${err?.message || "Error printer"}`);
    } finally {
      setBatchProgress(null);
    }
  };

  const handleTestPrint = async () => {
    if (!connectedPrinter) {
      toast.error("Hubungkan printer Bluetooth terlebih dahulu.");
      return;
    }
    try {
      // Uses ultra-fast native ESC/POS text or TSPL BOX+TEXT (~200 bytes) for instant printout
      const bytes = encodeFastTestPrint(
        connectedPrinter.name,
        protocol,
        paperWidthMm,
        paperHeightMm,
      );
      await sendBytesToConnectedPrinter(bytes);
      toast.success("Test print cepat berhasil dikirim!");
    } catch (err: any) {
      toast.error(err?.message || "Test print gagal.");
    }
  };

  const handleSystemPrintPage = async (page: PdfPageCardData) => {
    try {
      const canvas = await renderPdfPageToCanvas(page.file, page.pageNumber, 2.5);
      const handledAndroid = triggerAndroidSystemPrint(
        canvas,
        `Resi_${page.category}_Hal_${page.pageNumber}`,
      );
      if (!handledAndroid) {
        const dataUrl = canvas.toDataURL("image/png");
        const w = window.open("", "_blank");
        if (w) {
          w.document.write(
            `<html><head><title>Resi Hal ${page.pageNumber}</title><style>body{margin:0;display:flex;justify-content:center}img{max-width:100%;height:auto}</style></head><body><img src="${dataUrl}" onload="window.print();"/></body></html>`,
          );
          w.document.close();
        } else {
          toast.error("Pop-up diblokir browser.");
        }
      }
    } catch (err: any) {
      toast.error(err?.message || "Gagal menyiapkan print sistem.");
    }
  };

  const visibleCategories =
    selectedCategory === "all"
      ? orderedCategories
      : orderedCategories.filter((c) => c === selectedCategory);

  return (
    <div className="space-y-4">
      {/* TOP BAR: BLUETOOTH PRINTER STATUS & VIEW SWITCHER */}
      <Card className="border border-border/80 bg-card shadow-2xs rounded-xl">
        <CardContent className="p-3 sm:p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {/* Printer Status */}
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${
                connectedPrinter
                  ? "bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950/40 dark:border-emerald-800 dark:text-emerald-400"
                  : "bg-muted border-border/60 text-muted-foreground"
              }`}
            >
              {connectedPrinter ? (
                <BluetoothConnected className="h-4 w-4" />
              ) : (
                <Bluetooth className="h-4 w-4" />
              )}
            </div>
            <div className="min-w-0">
              <p className="text-xs sm:text-sm font-bold text-foreground truncate">
                {connectedPrinter ? connectedPrinter.name : "Printer Bluetooth"}
              </p>
              <p className="text-[11px] text-muted-foreground truncate">
                {connectedPrinter
                  ? `Terhubung · ${paperWidthMm}×${paperHeightMm}mm · ${protocol.toUpperCase()} (${speedMode === "fast" ? "Cepat" : "Normal"})`
                  : `Kertas ${paperWidthMm}×${paperHeightMm}mm · Cari & hubungkan printer Bluetooth`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant={connectedPrinter ? "outline" : "default"}
              onClick={handleOpenBtScanner}
              className="h-8 text-xs font-semibold gap-1.5"
            >
              <BluetoothSearching className="h-3.5 w-3.5" />
              {connectedPrinter ? "Ganti / Atur Printer" : "Cari Printer Bluetooth"}
            </Button>

            {/* Toggle Gambar PDF vs Tabel Teks Mentah */}
            <div className="inline-flex rounded-lg border border-border/80 bg-muted/40 p-0.5">
              <button
                type="button"
                onClick={() => setViewMode("pdf")}
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  viewMode === "pdf"
                    ? "bg-card text-foreground shadow-2xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <ImageIcon className="h-3 w-3" /> Gambar PDF
              </button>
              <button
                type="button"
                onClick={() => setViewMode("table")}
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  viewMode === "table"
                    ? "bg-card text-foreground shadow-2xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <TableIcon className="h-3 w-3" /> Tabel Teks
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* BATCH PRINT PROGRESS BANNER */}
      {batchProgress && (
        <Card className="border border-border bg-muted/40 rounded-xl">
          <CardContent className="p-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Loader2 className="h-4 w-4 animate-spin text-foreground shrink-0" />
              <div className="text-xs">
                <p className="font-bold text-foreground">
                  Mencetak {batchProgress.label}: {batchProgress.current} / {batchProgress.total} resi
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Pastikan printer Bluetooth tetap menyala dan kertas label tersedia.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                cancelBatchRef.current = true;
              }}
              className="h-7 text-xs shrink-0"
            >
              Batal
            </Button>
          </CardContent>
        </Card>
      )}

      {/* VIEW 1: PDF PAGE IMAGES PER CATEGORY (HITAM, HIJAU, BITUMAX) */}
      {viewMode === "pdf" ? (
        <div className="space-y-4">
          {/* CATEGORY FILTER PILLS */}
          <div className="flex flex-wrap items-center gap-1.5 px-0.5">
            <button
              type="button"
              onClick={() => setSelectedCategory("all")}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold border transition-colors ${
                selectedCategory === "all"
                  ? "bg-foreground text-background border-foreground"
                  : "bg-card text-muted-foreground border-border/80 hover:text-foreground"
              }`}
            >
              Semua ({totalUniquePages})
            </button>
            {(["hitam", "hijau", "bitumax"] as ProductCategory[]).map((cat) => {
              const count = pagesByCategory[cat].length;
              const active = selectedCategory === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCategory(cat)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold border transition-colors ${
                    active
                      ? "bg-foreground text-background border-foreground"
                      : "bg-card text-muted-foreground border-border/80 hover:text-foreground"
                  }`}
                >
                  {CATEGORY_META[cat].label} ({count})
                </button>
              );
            })}
          </div>

          {visibleCategories.length === 0 ? (
            <Card className="border border-dashed border-border/80 bg-card rounded-xl">
              <CardContent className="py-8 text-center text-xs sm:text-sm text-muted-foreground">
                Tidak ada halaman PDF pada kategori yang dipilih.
              </CardContent>
            </Card>
          ) : (
            visibleCategories.map((cat) => {
              const pages = pagesByCategory[cat];
              const meta = CATEGORY_META[cat];
              const totalPcs = pages.reduce((acc, p) => acc + p.totalQty, 0);

              return (
                <Card
                  key={cat}
                  className={`overflow-hidden border border-border/80 shadow-2xs rounded-xl sm:rounded-2xl border-l-[4px] ${meta.accentBorder} bg-card`}
                >
                  <CardHeader className="py-3 px-4 sm:px-5 border-b border-border/60 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2 flex-wrap">
                      <CardTitle className="text-sm sm:text-base font-bold text-foreground">
                        {meta.label}
                      </CardTitle>
                      <Badge variant="outline" className={`text-[10px] font-semibold ${meta.badgeClass}`}>
                        {pages.length} halaman PDF · {totalPcs} pcs
                      </Badge>
                    </div>

                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(batchProgress)}
                      onClick={() => printCategoryBatch(cat)}
                      className="h-8 text-xs font-semibold gap-1.5 self-start sm:self-auto"
                    >
                      <Printer className="h-3.5 w-3.5" />
                      Print Semua {meta.label.split(" ")[0]} ({pages.length})
                    </Button>
                  </CardHeader>

                  <CardContent className="p-3 sm:p-4 bg-muted/15">
                    <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                      {pages.map((page) => (
                        <PdfPageCard
                          key={page.key}
                          page={page}
                          isPrinting={printingKey === page.key}
                          onPrintBluetooth={() => printSinglePage(page)}
                          onZoom={() => setZoomPage(page)}
                        />
                      ))}
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      ) : (
        /* VIEW 2: TABEL TEKS MENTAH */
        <Card className="border border-border/80 shadow-2xs rounded-xl bg-card">
          <CardHeader className="py-3 px-4 sm:px-5 border-b border-border/60">
            <CardTitle className="text-sm sm:text-base font-bold">
              Baris Mentah Terdeteksi ({rows.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 sm:p-4">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16 text-xs">Hal.</TableHead>
                    <TableHead className="text-xs">Nama Produk</TableHead>
                    <TableHead className="w-24 text-xs">Kategori</TableHead>
                    <TableHead className="w-28 text-xs">Seller SKU</TableHead>
                    <TableHead className="w-20 text-xs">Ukuran</TableHead>
                    <TableHead className="w-16 text-right text-xs">Qty</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => (
                    <TableRow key={i} className="text-xs">
                      <TableCell className="py-2.5 text-muted-foreground tabular-nums">
                        {r.pageNumber ?? "-"}
                      </TableCell>
                      <TableCell className="font-medium py-2.5 leading-snug">{r.name}</TableCell>
                      <TableCell className="py-2.5">
                        <Badge
                          variant="outline"
                          className={`text-[10px] px-2 py-0.5 font-semibold uppercase ${
                            CATEGORY_META[r.category]?.badgeClass ?? ""
                          }`}
                        >
                          {r.category}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-2.5 font-mono text-[11px] text-muted-foreground">
                        {r.sku || "-"}
                      </TableCell>
                      <TableCell className="py-2.5">
                        <Badge variant="secondary" className="text-[10px] px-2 py-0.5 font-bold">
                          {r.size ?? "-"}
                          {r.pageWeightSize && r.size === r.pageWeightSize ? " (Resi)" : ""}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-bold tabular-nums py-2.5">{r.qty}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* MODAL ZOOM PREVIEW PDF PAGE */}
      <Dialog open={Boolean(zoomPage)} onOpenChange={(open) => !open && setZoomPage(null)}>
        <DialogContent className="sm:max-w-xl max-h-[90vh] flex flex-col p-4">
          <DialogHeader>
            <DialogTitle className="text-sm sm:text-base font-bold flex items-center gap-2 flex-wrap">
              <span>Preview Resi Halaman {zoomPage?.pageNumber}</span>
              {zoomPage && (
                <Badge
                  variant="outline"
                  className={`text-[10px] font-semibold ${CATEGORY_META[zoomPage.category].badgeClass}`}
                >
                  {CATEGORY_META[zoomPage.category].label}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription className="text-xs truncate">
              {zoomPage?.fileName} · {zoomPage?.items.map((it) => `${it.size || "-"} (×${it.qty})`).join(", ")}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto rounded-lg border border-border bg-muted/30 p-2 flex items-center justify-center min-h-[300px]">
            {zoomImageUrl ? (
              <img
                src={zoomImageUrl}
                alt={`Resi Halaman ${zoomPage?.pageNumber}`}
                className="max-w-full h-auto rounded border border-border/50 bg-white shadow-xs"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-muted-foreground py-12">
                <Loader2 className="h-6 w-6 animate-spin" />
                <span className="text-xs">Merender resolusi tinggi…</span>
              </div>
            )}
          </div>

          <DialogFooter className="flex-row gap-2 sm:justify-between pt-2">
            <Button
              variant="outline"
              size="sm"
              className="text-xs gap-1.5"
              onClick={() => zoomPage && handleSystemPrintPage(zoomPage)}
            >
              <Printer className="h-3.5 w-3.5" /> Print Sistem / PDF
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => setZoomPage(null)}>
                Tutup
              </Button>
              <Button
                size="sm"
                className="text-xs gap-1.5 font-semibold"
                disabled={Boolean(printingKey)}
                onClick={() => zoomPage && printSinglePage(zoomPage)}
              >
                {printingKey === zoomPage?.key ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Bluetooth className="h-3.5 w-3.5" />
                )}
                Print via Bluetooth
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* MODAL CARI PRINTER BLUETOOTH & PENGATURAN CETAK */}
      <Dialog open={isBtModalOpen} onOpenChange={setIsBtModalOpen}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-bold">
              <BluetoothSearching className="h-5 w-5" />
              Cari Printer Bluetooth
            </DialogTitle>
            <DialogDescription className="text-xs">
              Pilih printer thermal Bluetooth yang sudah di-pair atau berada di sekitar Anda.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            {/* CONNECTED PRINTER BOX */}
            {connectedPrinter && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-300 bg-emerald-50/70 dark:border-emerald-800 dark:bg-emerald-950/30 p-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-foreground truncate">{connectedPrinter.name}</p>
                    <p className="text-[10px] font-mono text-muted-foreground truncate">
                      {connectedPrinter.address}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={handleTestPrint}>
                    Test Print
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    onClick={handleDisconnectPrinter}
                    title="Putuskan"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}

            {/* DISCOVERY CONTROLS */}
            {isAndroidBt ? (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground">
                    Daftar Perangkat Bluetooth ({discoveredPrinters.length})
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleRescanAndroid}
                    disabled={isScanning}
                    className="h-7 text-[11px] gap-1"
                  >
                    {isScanning ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    {isScanning ? "Mencari…" : "Scan Sekitar"}
                  </Button>
                </div>

                <div className="max-h-52 overflow-y-auto rounded-lg border border-border/80 divide-y divide-border/50 bg-muted/20">
                  {discoveredPrinters.length === 0 ? (
                    <div className="py-6 px-4 text-center text-xs text-muted-foreground">
                      {isScanning
                        ? "Sedang mencari printer Bluetooth di sekitar…"
                        : "Belum ada perangkat ditemukan. Pastikan Bluetooth HP & Printer aktif lalu tap Scan Sekitar."}
                    </div>
                  ) : (
                    discoveredPrinters.map((dev) => {
                      const isConnected = connectedPrinter?.address === dev.address;
                      const isConnecting = connectingAddress === dev.address;
                      return (
                        <div
                          key={dev.address}
                          className="flex items-center justify-between gap-2 p-2.5 hover:bg-muted/40 transition-colors"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="text-xs font-semibold text-foreground truncate">{dev.name}</p>
                              {dev.bonded && (
                                <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
                                  Terpasang
                                </Badge>
                              )}
                            </div>
                            <p className="text-[10px] font-mono text-muted-foreground">{dev.address}</p>
                          </div>

                          <Button
                            size="sm"
                            variant={isConnected ? "secondary" : "outline"}
                            disabled={isConnecting || isConnected}
                            onClick={() => handleConnectAndroid(dev)}
                            className="h-7 text-[11px] shrink-0"
                          >
                            {isConnecting ? (
                              <>
                                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Sambung…
                              </>
                            ) : isConnected ? (
                              "Terhubung"
                            ) : (
                              "Hubungkan"
                            )}
                          </Button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ) : isWebBt ? (
              <div className="rounded-lg border border-border/80 bg-muted/20 p-3 space-y-2.5 text-center">
                <p className="text-xs text-muted-foreground">
                  Klik tombol di bawah untuk mencari printer Bluetooth BLE melalui browser Chrome / Edge.
                </p>
                <Button
                  size="sm"
                  onClick={handleConnectWebBluetooth}
                  disabled={isScanning}
                  className="w-full h-9 text-xs font-semibold gap-1.5"
                >
                  {isScanning ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <BluetoothSearching className="h-4 w-4" />
                  )}
                  Cari Printer Bluetooth (Web Bluetooth)
                </Button>
              </div>
            ) : (
              <div className="rounded-lg border border-amber-300/60 bg-amber-50/50 dark:bg-amber-950/20 p-3 flex items-start gap-2.5 text-xs text-muted-foreground">
                <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-foreground">Bluetooth Langsung Tidak Tersedia di Browser Ini</p>
                  <p className="mt-0.5 text-[11px]">
                    Gunakan aplikasi <strong>Android Resi Scanner APK</strong> untuk scan printer Bluetooth Classic, atau
                    buka di Google Chrome/Edge desktop. Anda tetap bisa klik <strong>Preview &rarr; Print Sistem</strong>.
                  </p>
                </div>
              </div>
            )}

            {/* THERMAL PRINT SETTINGS */}
            <div className="rounded-lg border border-border/70 bg-muted/15 p-3 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <SlidersHorizontal className="h-3.5 w-3.5" /> Pengaturan Kertas & Cetak
                </div>
                <span className="text-[10px] font-mono text-muted-foreground">
                  {printAreaDots.widthDots}×{printAreaDots.heightDots} dot
                </span>
              </div>

              {/* Quick Presets */}
              <div className="space-y-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Preset Cepat
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    { w: "58", h: "100", label: "58 × 100 mm" },
                    { w: "80", h: "120", label: "80 × 120 mm" },
                    { w: "100", h: "150", label: "100 × 150 mm" },
                  ].map((preset) => {
                    const active = paperWidthInput === preset.w && paperHeightInput === preset.h;
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          setPaperWidthInput(preset.w);
                          setPaperHeightInput(preset.h);
                        }}
                        className={`rounded-md py-1 text-[11px] font-semibold border transition-colors ${
                          active
                            ? "bg-foreground text-background border-foreground"
                            : "bg-card text-muted-foreground border-border/80 hover:text-foreground"
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Manual Paper Width & Height Inputs */}
              <div className="grid grid-cols-2 gap-2.5">
                <div className="space-y-1">
                  <label
                    htmlFor="paper-width-mm"
                    className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    Paper Width (mm)
                  </label>
                  <div className="relative">
                    <input
                      id="paper-width-mm"
                      type="number"
                      min={20}
                      max={120}
                      step={1}
                      value={paperWidthInput}
                      onChange={(e) => setPaperWidthInput(e.target.value)}
                      onBlur={() => setPaperWidthInput(String(paperWidthMm))}
                      className="h-8 w-full rounded-md border border-border bg-card px-2.5 pr-9 text-xs font-semibold tabular-nums text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="80"
                    />
                    <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-medium text-muted-foreground">
                      mm
                    </span>
                  </div>
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="paper-height-mm"
                    className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    Paper Height (mm)
                  </label>
                  <div className="relative">
                    <input
                      id="paper-height-mm"
                      type="number"
                      min={20}
                      max={300}
                      step={1}
                      value={paperHeightInput}
                      onChange={(e) => setPaperHeightInput(e.target.value)}
                      onBlur={() => setPaperHeightInput(String(paperHeightMm))}
                      className="h-8 w-full rounded-md border border-border bg-card px-2.5 pr-9 text-xs font-semibold tabular-nums text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="120"
                    />
                    <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-medium text-muted-foreground">
                      mm
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Mode Printer
                  </label>
                  <div className="grid grid-cols-2 gap-1">
                    {(
                      [
                        { id: "escpos", label: "ESC/POS" },
                        { id: "tspl", label: "TSPL" },
                      ] as { id: PrinterProtocol; label: string }[]
                    ).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setProtocol(m.id)}
                        className={`rounded-md py-1 text-[11px] font-semibold border transition-colors ${
                          protocol === m.id
                            ? "bg-foreground text-background border-foreground"
                            : "bg-card text-muted-foreground border-border/80 hover:text-foreground"
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Kecepatan Print
                  </label>
                  <div className="grid grid-cols-2 gap-1">
                    {(
                      [
                        { id: "normal", label: "Tajam" },
                        { id: "fast", label: "Cepat 2x" },
                      ] as { id: PrintQualitySpeed; label: string }[]
                    ).map((sp) => (
                      <button
                        key={sp.id}
                        type="button"
                        onClick={() => setSpeedMode(sp.id)}
                        className={`rounded-md py-1 text-[11px] font-semibold border transition-colors ${
                          speedMode === sp.id
                            ? "bg-foreground text-background border-foreground"
                            : "bg-card text-muted-foreground border-border/80 hover:text-foreground"
                        }`}
                      >
                        {sp.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Ketebalan Tinta / Kontras Barcode
                </label>
                <div className="grid grid-cols-3 gap-1">
                  {[
                    { val: 155, label: "Terang" },
                    { val: 175, label: "Normal" },
                    { val: 205, label: "Lebih Gelap" },
                  ].map((opt) => (
                    <button
                      key={opt.val}
                      type="button"
                      onClick={() => setThreshold(opt.val)}
                      className={`rounded-md py-1 text-[11px] font-semibold border transition-colors ${
                        threshold === opt.val
                          ? "bg-foreground text-background border-foreground"
                          : "bg-card text-muted-foreground border-border/80 hover:text-foreground"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button size="sm" onClick={() => setIsBtModalOpen(false)} className="w-full sm:w-auto text-xs">
              Selesai
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Lazy-rendered PDF page thumbnail card using IntersectionObserver.
 */
function PdfPageCard({
  page,
  isPrinting,
  onPrintBluetooth,
  onZoom,
}: {
  page: PdfPageCardData;
  isPrinting: boolean;
  onPrintBluetooth: () => void;
  onZoom: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(
    () => getCachedPreviewUrl(page.file, page.pageNumber),
  );
  const [error, setError] = useState(false);

  useEffect(() => {
    const cached = getCachedPreviewUrl(page.file, page.pageNumber);
    if (cached) {
      setImgUrl(cached);
      return;
    }

    let cancelled = false;
    let observer: IntersectionObserver | null = null;

    const loadImage = () => {
      renderPdfPageToDataUrl(page.file, page.pageNumber, 1.4)
        .then((url) => {
          setCachedPreviewUrl(page.file, page.pageNumber, url);
          if (!cancelled) setImgUrl(url);
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
    };

    if (typeof IntersectionObserver !== "undefined" && containerRef.current) {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            loadImage();
            observer?.disconnect();
          }
        },
        { rootMargin: "200px" },
      );
      observer.observe(containerRef.current);
    } else {
      loadImage();
    }

    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [page.file, page.fileIdx, page.fileName, page.pageNumber]);

  const sizeSummary = page.items.map((it) => `${it.size ?? "-"} ×${it.qty}`).join(" · ");

  return (
    <div
      ref={containerRef}
      className="flex flex-col overflow-hidden rounded-xl border border-border/80 bg-card shadow-2xs transition-colors hover:border-border"
    >
      {/* CARD HEADER */}
      <div className="flex items-center justify-between gap-2 px-2.5 py-2 border-b border-border/60 bg-muted/20">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[11px] font-bold text-foreground shrink-0">Hal. {page.pageNumber}</span>
          <span className="text-[10px] font-semibold text-muted-foreground truncate bg-muted px-1.5 py-0.5 rounded">
            {sizeSummary}
          </span>
        </div>
        <button
          type="button"
          onClick={onZoom}
          className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted transition-colors shrink-0"
          title="Perbesar Preview"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* PDF IMAGE PREVIEW */}
      <div
        onClick={onZoom}
        className="relative aspect-[3/4] w-full cursor-pointer overflow-hidden bg-white flex items-center justify-center p-1.5"
      >
        {imgUrl ? (
          <img
            src={imgUrl}
            alt={`Resi ${page.category} Hal ${page.pageNumber}`}
            className="max-h-full max-w-full object-contain"
          />
        ) : error ? (
          <span className="text-[11px] text-destructive">Gagal memuat gambar</span>
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-[10px]">Memuat PDF…</span>
          </div>
        )}
      </div>

      {/* FOOTER PRINT ACTION */}
      <div className="p-2 border-t border-border/60 bg-card flex items-center justify-between gap-1.5">
        <span className="text-[10px] text-muted-foreground truncate" title={page.fileName}>
          {page.fileName}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={isPrinting}
          onClick={onPrintBluetooth}
          className="h-7 px-2.5 text-[11px] font-semibold gap-1 shrink-0"
        >
          {isPrinting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Printer className="h-3 w-3" />
          )}
          Print
        </Button>
      </div>
    </div>
  );
}
