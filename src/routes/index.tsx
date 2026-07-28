import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useMemo } from "react";
import {
  FileUp,
  Loader2,
  Package,
  Trash2,
  FileText,
  Ruler,
  Layers,
  Hash,
  Boxes,
  Plus,
  X,
  ChevronDown,
  ChevronUp,
  Database,
  Save,
  Download,
  Copy,
  ExternalLink,
  Check,
  Edit3,
  Calendar,
  ShoppingBag,
  ArrowDownRight,
  ArrowUpRight,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  extractRowsFromPdf,
  parseProducts,
  type GroupedProduct,
  type ProductRow,
} from "@/lib/pdf-parser";
import { DB_CONFIG } from "@/lib/db";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PDF Product & Size Detector" },
      {
        name: "description",
        content:
          "Unggah PDF pesanan dan pisahkan produk berdasarkan ukuran, lengkap dengan jumlah (qty) otomatis.",
      },
      { property: "og:title", content: "PDF Product & Size Detector" },
      {
        property: "og:description",
        content: "Deteksi produk & pisahkan ukuran serta qty dari file PDF.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type FileEntry = {
  name: string;
  rows: ProductRow[];
};

function Index() {
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [showAllFiles, setShowAllFiles] = useState(false);
  // Open size card accordions; empty means all are MINIMIZED by default on initial load
  const [openSizes, setOpenSizes] = useState<Record<string, boolean>>({});
  // Save DB Modal state
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Selected date for database entry (default: today YYYY-MM-DD)
  const [saveDate, setSaveDate] = useState(() => new Date().toISOString().split("T")[0]);
  // Transaction action mode: 'out' (Stok Keluar / Mengurangi Stok) or 'in' (Stok Masuk / Menambah Stok)
  const [actionType, setActionType] = useState<"out" | "in">("out");
  // Default Sales Channel for Outbound PDF sales resi
  const [salesChannel, setSalesChannel] = useState("Online (Marketplace/Web)");
  // Target product name in inventoryaspal.vercel.app
  const [targetProductName, setTargetProductName] = useState("Aspal Emulsion Waterproofing Baru");

  const processFiles = useCallback(async (fileList: File[]) => {
    const pdfs = fileList.filter(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
    );
    if (pdfs.length === 0) {
      toast.error("File harus berformat PDF");
      return;
    }
    setLoading(true);
    try {
      const newEntries: FileEntry[] = [];
      for (const file of pdfs) {
        try {
          const rawRows = await extractRowsFromPdf(file);
          const { rows: parsed } = parseProducts(rawRows);
          newEntries.push({ name: file.name, rows: parsed });
        } catch (e) {
          console.error(e);
          toast.error(`Gagal membaca ${file.name}`);
        }
      }
      if (newEntries.length > 0) {
        setFiles((prev) => [...prev, ...newEntries]);
        const totalRows = newEntries.reduce((s, e) => s + e.rows.length, 0);
        toast.success(
          `${newEntries.length} file ditambahkan (${totalRows} baris produk)`,
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const resetAll = () => {
    setFiles([]);
    setOpenSizes({});
  };

  // Merge all rows across uploaded files, then regroup
  const { rows, grouped } = useMemo(() => {
    const allRaw = files.flatMap((f) => f.rows.map((r) => ({ name: r.raw, qty: r.qty })));
    return parseProducts(allRaw);
  }, [files]);

  const totalQty = grouped.reduce((s, g) => s + g.totalQty, 0);
  const totalVariants = grouped.reduce((s, g) => s + g.variants.length, 0);

  const bySize = useMemo(() => {
    const map = new Map<string, { size: string; items: { name: string; qty: number }[]; totalQty: number }>();
    for (const g of grouped) {
      for (const v of g.variants) {
        if (!map.has(v.size)) map.set(v.size, { size: v.size, items: [], totalQty: 0 });
        const bucket = map.get(v.size)!;
        bucket.items.push({ name: g.name, qty: v.qty });
        bucket.totalQty += v.qty;
      }
    }
    return [...map.values()].sort((a, b) =>
      a.size.localeCompare(b.size, undefined, { numeric: true, sensitivity: "base" }),
    );
  }, [grouped]);

  // Map sizes to standard 1, 5, 20, 25 for inventoryaspal.vercel.app DB
  const mappedStandardSizes = useMemo(() => {
    const qtyMap: Record<string, number> = { "1": 0, "5": 0, "20": 0, "25": 0 };
    
    for (const s of bySize) {
      // Extract numeric size
      const sizeStr = s.size.replace(/[^\d.]/g, "");
      if (sizeStr === "1") qtyMap["1"] += s.totalQty;
      else if (sizeStr === "5") qtyMap["5"] += s.totalQty;
      else if (sizeStr === "20") qtyMap["20"] += s.totalQty;
      else if (sizeStr === "25") qtyMap["25"] += s.totalQty;
      else if (sizeStr) {
        qtyMap[sizeStr] = (qtyMap[sizeStr] ?? 0) + s.totalQty;
      }
    }
    return qtyMap;
  }, [bySize]);

  const toggleSize = (sizeKey: string) => {
    setOpenSizes((prev) => ({ ...prev, [sizeKey]: !prev[sizeKey] }));
  };

  const expandAllSizes = () => {
    const all: Record<string, boolean> = {};
    for (const s of bySize) all[s.size] = true;
    setOpenSizes(all);
  };

  const collapseAllSizes = () => {
    setOpenSizes({});
  };

  // Generate MySQL dump content specifically for database 'inventory' (Aiven Cloud MySQL)
  // Ensures stock NEVER becomes negative using GREATEST(0, stock - qty)
  const generatedSql = useMemo(() => {
    const now = new Date();
    const timePart = now.toTimeString().split(" ")[0] ?? "12:00:00";
    const timestamp = `${saveDate} ${timePart}`;
    const fileTimestamp = now.getTime();
    const productEscaped = targetProductName.replace(/'/g, "''");
    const channelEscaped = salesChannel.replace(/'/g, "''");
    const isOut = actionType === "out";
    const dbTypeLabel = isOut ? "out" : "in";

    const productValues: string[] = [];
    const inventoryValues: string[] = [];

    // Standard sizes 1, 5, 20, 25
    const sizesToExport = ["1", "5", "20", "25"];
    for (const sz of Object.keys(mappedStandardSizes)) {
      if (!sizesToExport.includes(sz)) sizesToExport.push(sz);
    }

    for (const sz of sizesToExport) {
      const qty = mappedStandardSizes[sz] ?? 0;
      productValues.push(`('${productEscaped}', '${sz}', ${qty}, 'Aspal')`);
      if (qty > 0) {
        inventoryValues.push(`('${productEscaped}', '${sz}', ${qty}, '${dbTypeLabel}', '${channelEscaped}', '${timestamp}')`);
      }
    }

    // Protection against negative stock: GREATEST(0, stock - VALUES(stock)) for OUT transactions
    const stockUpdateClause = isOut
      ? "`stock` = GREATEST(0, `stock` - VALUES(`stock`))"
      : "`stock` = `stock` + VALUES(`stock`)";

    return `-- ============================================================
-- AIVEN MYSQL DATABASE SYNC (inventoryaspal.vercel.app)
-- Target Database: ${DB_CONFIG.database} (${DB_CONFIG.host})
-- Target Product: ${targetProductName}
-- Mode Transaksi: ${isOut ? "OUT / KELUAR (Mengurangi Stok - Tidak Bisa Minus)" : "IN / MASUK (Menambah Stok)"}
-- Tanggal Transaksi: ${saveDate} (${timestamp})
-- File Reference ID: inventory_sync_${fileTimestamp}.sql
-- ============================================================

CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\`;
USE \`${DB_CONFIG.database}\`;

-- 1. Update Tabel 'products' (Stok Ukuran 1, 5, 20, 25)
CREATE TABLE IF NOT EXISTS \`products\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`name\` VARCHAR(255) NOT NULL,
  \`size\` VARCHAR(50) NOT NULL,
  \`stock\` INT NOT NULL DEFAULT 0,
  \`category\` VARCHAR(100) DEFAULT 'Aspal',
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY \`name_size_unique\` (\`name\`, \`size\`)
);

INSERT INTO \`products\` (\`name\`, \`size\`, \`stock\`, \`category\`, \`updated_at\`) VALUES
${productValues.join(",\n")}
ON DUPLICATE KEY UPDATE ${stockUpdateClause}, \`updated_at\` = VALUES(\`updated_at\`);

-- 2. Catat Transaksi di Tabel 'inventory' (Tipe: ${dbTypeLabel.toUpperCase()})
CREATE TABLE IF NOT EXISTS \`inventory\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`product_name\` VARCHAR(255) NOT NULL,
  \`size\` VARCHAR(50) NOT NULL,
  \`quantity\` INT NOT NULL DEFAULT 0,
  \`type\` ENUM('in', 'out', 'masuk', 'keluar') DEFAULT '${dbTypeLabel}',
  \`sales_channel\` VARCHAR(100) DEFAULT '${channelEscaped}',
  \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP
);

${
  inventoryValues.length > 0
    ? `INSERT INTO \`inventory\` (\`product_name\`, \`size\`, \`quantity\`, \`type\`, \`sales_channel\`, \`created_at\`) VALUES
${inventoryValues.join(",\n")};`
    : "-- (Belum ada kuantitas transaksi)"
}
`;
  }, [targetProductName, mappedStandardSizes, saveDate, salesChannel, actionType]);

  const handleDownloadAndSaveSql = () => {
    const filename = `inventory_${actionType}_${saveDate}_${Date.now()}.sql`;
    const blob = new Blob([generatedSql], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast.success(`Data (${actionType.toUpperCase()}) berhasil disimpan & file SQL (${filename}) telah dibuat!`);
    setIsSaveModalOpen(false);
  };

  const handleCopySql = async () => {
    try {
      await navigator.clipboard.writeText(generatedSql);
      setCopied(true);
      toast.success("Query SQL berhasil disalin!");
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error("Gagal menyalin script SQL");
    }
  };

  const hasFiles = files.length > 0;

  return (
    <div className="min-h-screen pb-16" style={{ background: "var(--gradient-subtle)" }}>
      {/* HEADER */}
      <header className="sticky top-0 z-20 border-b bg-card/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-3 py-3 sm:px-4 sm:py-4">
          <div className="flex items-center gap-2.5 sm:gap-3">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-xl text-primary-foreground shadow-md sm:h-10 sm:w-10 shrink-0"
              style={{ background: "var(--gradient-primary)" }}
            >
              <FileText className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base sm:text-lg font-bold tracking-tight leading-tight">
                PDF Product & Size Detector
              </h1>
              <p className="text-[11px] sm:text-xs text-muted-foreground hidden xs:block">
                Rekap ukuran & qty otomatis dari file PDF
              </p>
            </div>
          </div>

          {grouped.length > 0 && (
            <Button
              size="sm"
              onClick={() => setIsSaveModalOpen(true)}
              className="h-8 sm:h-9 text-xs font-bold gap-1.5 shadow-sm"
              style={{ background: "var(--gradient-primary)" }}
            >
              <Save className="h-3.5 w-3.5" /> Simpan ke DB
            </Button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-3 py-4 sm:px-4 sm:py-6 space-y-4 sm:space-y-6">
        {/* UPLOAD CARD */}
        {!hasFiles ? (
          <Card className="overflow-hidden border-0 shadow-sm hover:shadow-md transition-all" style={{ boxShadow: "var(--shadow-soft)" }}>
            <CardContent className="p-3 sm:p-4">
              <label
                htmlFor="pdf-file"
                className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border/80 bg-muted/30 px-4 py-10 sm:px-6 sm:py-14 text-center transition-all hover:border-primary/50 hover:bg-primary/5 active:scale-[0.99]"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-8 w-8 animate-spin text-primary sm:h-10 sm:w-10" />
                    <p className="text-xs sm:text-sm font-semibold text-muted-foreground">Memproses file PDF…</p>
                  </>
                ) : (
                  <>
                    <div
                      className="flex h-12 w-12 items-center justify-center rounded-full text-primary-foreground shadow-md sm:h-14 sm:w-14"
                      style={{ background: "var(--gradient-primary)" }}
                    >
                      <FileUp className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="text-sm sm:text-base font-bold">Pilih / Upload File PDF</p>
                      <p className="mt-1 text-xs text-muted-foreground max-w-md">
                        Bisa pilih beberapa file sekaligus. Nama produk, ukuran, & qty akan direkap otomatis.
                      </p>
                    </div>
                  </>
                )}
                <input
                  id="pdf-file"
                  type="file"
                  accept="application/pdf,.pdf"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const fs = Array.from(e.target.files ?? []);
                    if (fs.length) processFiles(fs);
                    e.target.value = "";
                  }}
                />
              </label>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-0 shadow-sm" style={{ boxShadow: "var(--shadow-soft)" }}>
            <CardContent className="p-3 sm:p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2.5 text-xs sm:text-sm">
                  <div
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-primary-foreground shrink-0"
                    style={{ background: "var(--gradient-primary)" }}
                  >
                    <FileText className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="font-bold leading-tight">{files.length} File PDF Diproses</p>
                    <p className="text-[11px] text-muted-foreground">Daftar produk telah digabungkan</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button asChild size="sm" className="h-8 text-xs font-semibold" disabled={loading}>
                    <label htmlFor="pdf-file-add" className="cursor-pointer">
                      {loading ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Plus className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Tambah PDF
                      <input
                        id="pdf-file-add"
                        type="file"
                        accept="application/pdf,.pdf"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          const fs = Array.from(e.target.files ?? []);
                          if (fs.length) processFiles(fs);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 text-xs text-destructive hover:bg-destructive/10" onClick={resetAll}>
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Hapus Semua
                  </Button>
                </div>
              </div>

              {/* FILE BADGES */}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {(showAllFiles ? files : files.slice(0, 4)).map((f, i) => {
                  const actualIdx = showAllFiles ? i : files.findIndex((file) => file === f);
                  const totalFileQty = f.rows.reduce((s, r) => s + r.qty, 0);
                  return (
                    <Badge
                      key={actualIdx}
                      variant="outline"
                      className="gap-1.5 pl-2.5 pr-1.5 py-1 text-xs font-normal bg-background/80 hover:bg-muted/60 border-border/80 rounded-xl transition-all shadow-2xs group"
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0 text-primary/70 group-hover:text-primary" />
                      <span className="truncate max-w-[130px] sm:max-w-[180px] font-medium">{f.name}</span>
                      <span className="tabular-nums font-bold text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-md">
                        {totalFileQty}
                      </span>
                      <button
                        onClick={() => removeFile(actualIdx >= 0 ? actualIdx : i)}
                        className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:text-destructive hover:bg-destructive/15 transition-colors"
                        aria-label={`Hapus ${f.name}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  );
                })}

                {files.length > 4 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAllFiles((prev) => !prev)}
                    className="h-7 text-xs text-primary font-bold gap-1 px-2.5 rounded-xl hover:bg-primary/10 transition-all border border-primary/20 bg-primary/5 cursor-pointer"
                  >
                    {showAllFiles ? (
                      <>
                        Sembunyikan <ChevronUp className="h-3.5 w-3.5" />
                      </>
                    ) : (
                      <>
                        +{files.length - 4} file lainnya <ChevronDown className="h-3.5 w-3.5" />
                      </>
                    )}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* SUMMARY & RESULTS */}
        {grouped.length > 0 && (
          <>
            {/* STAT CARDS */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
              <StatCard icon={<Package className="h-4 w-4" />} label="Produk Unik" value={grouped.length} />
              <StatCard icon={<Layers className="h-4 w-4" />} label="Total Varian" value={totalVariants} />
              <StatCard icon={<Ruler className="h-4 w-4" />} label="Ukuran" value={bySize.length} />
              <StatCard icon={<Hash className="h-4 w-4" />} label="Total Qty" value={totalQty} accent />
            </div>

            {/* TABS */}
            <Tabs defaultValue="size" className="w-full">
              <TabsList className="grid w-full grid-cols-3 h-10 p-1 bg-muted/60 rounded-xl">
                <TabsTrigger value="size" className="gap-1 text-xs font-semibold sm:text-sm">
                  <Ruler className="h-3.5 w-3.5 sm:h-4 sm:w-4" /> Per Ukuran
                </TabsTrigger>
                <TabsTrigger value="product" className="gap-1 text-xs font-semibold sm:text-sm">
                  <Boxes className="h-3.5 w-3.5 sm:h-4 sm:w-4" /> Per Produk
                </TabsTrigger>
                <TabsTrigger value="raw" className="gap-1 text-xs font-semibold sm:text-sm">
                  <FileText className="h-3.5 w-3.5 sm:h-4 sm:w-4" /> Detail Mentah
                </TabsTrigger>
              </TabsList>

              {/* TAB 1: PER UKURAN */}
              <TabsContent value="size" className="mt-4 space-y-3">
                {/* TOOLBAR FOR EXPAND / COLLAPSE ALL */}
                <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
                  <span className="text-[11px] font-medium">Tampilan awal: Minimize (diklik untuk buka)</span>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[11px] gap-1 px-2 text-primary font-medium hover:bg-primary/10"
                      onClick={expandAllSizes}
                    >
                      <ChevronDown className="h-3 w-3" /> Buka Semua
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[11px] gap-1 px-2 text-muted-foreground font-medium hover:bg-muted"
                      onClick={collapseAllSizes}
                    >
                      <ChevronUp className="h-3 w-3" /> Tutup Semua
                    </Button>
                  </div>
                </div>

                {bySize.map((s, i) => {
                  const isOpen = !!openSizes[s.size];
                  return (
                    <SizeCard
                      key={i}
                      s={s}
                      isExpanded={isOpen}
                      onToggle={() => toggleSize(s.size)}
                    />
                  );
                })}
              </TabsContent>

              {/* TAB 2: PER PRODUK */}
              <TabsContent value="product" className="mt-4 space-y-2.5">
                {grouped.map((g, i) => (
                  <ProductCard key={i} g={g} />
                ))}
              </TabsContent>

              {/* TAB 3: DETAIL MENTAH */}
              <TabsContent value="raw" className="mt-4">
                <Card className="border-0 shadow-sm" style={{ boxShadow: "var(--shadow-soft)" }}>
                  <CardHeader className="py-3 px-4 sm:px-5">
                    <CardTitle className="text-sm sm:text-base font-bold">Baris Mentah Terdeteksi ({rows.length})</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0 sm:p-4">
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-xs">Nama Produk</TableHead>
                            <TableHead className="w-20 text-xs">Ukuran</TableHead>
                            <TableHead className="w-16 text-right text-xs">Qty</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rows.map((r, i) => (
                            <TableRow key={i} className="text-xs">
                              <TableCell className="font-medium py-2.5 leading-snug">{r.name}</TableCell>
                              <TableCell className="py-2.5">
                                <Badge variant={r.size ? "default" : "outline"} className="text-[10px] px-2 py-0.5 font-bold">
                                  {r.size ?? "-"}
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
              </TabsContent>
            </Tabs>

            {/* ACTION SECTION BELOW RESULTS FOR SAVE TO DB */}
            <div className="mt-6 pt-4 border-t border-border/60">
              <Card className="border border-primary/20 bg-card overflow-hidden shadow-sm">
                <CardContent className="p-4 sm:p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div className="flex items-center gap-3 text-center sm:text-left">
                    <div
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-primary-foreground shadow-sm"
                      style={{ background: "var(--gradient-primary)" }}
                    >
                      <Database className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="font-bold text-sm sm:text-base leading-tight">Simpan Rekap ke DB Inventory (IN / OUT)</h3>
                      <p className="text-xs text-muted-foreground mt-0.5 max-w-lg">
                        Simpan transaksi ke database <span className="text-primary font-semibold">inventory</span> (Ukuran 1, 5, 20, 25).
                      </p>
                    </div>
                  </div>

                  <Button
                    size="lg"
                    onClick={() => setIsSaveModalOpen(true)}
                    className="w-full sm:w-auto font-bold gap-2 shadow-md shrink-0 h-11 px-6 rounded-xl text-sm"
                    style={{ background: "var(--gradient-primary)" }}
                  >
                    <Save className="h-4 w-4" /> Simpan ke DB Inventory
                  </Button>
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </main>

      {/* MODAL SIMPAN KE DATABASE */}
      <Dialog open={isSaveModalOpen} onOpenChange={setIsSaveModalOpen}>
        <DialogContent className="max-w-xl p-5 sm:p-6 rounded-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-2.5">
              <div
                className="flex h-9 w-9 items-center justify-center rounded-xl text-primary-foreground shadow-sm shrink-0"
                style={{ background: "var(--gradient-primary)" }}
              >
                <Database className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle className="text-base sm:text-lg font-bold">
                  Simpan Transaksi ke DB Inventory
                </DialogTitle>
                <p className="text-[11px] text-muted-foreground">
                  Database: <span className="text-primary font-medium">{DB_CONFIG.database}</span> ({DB_CONFIG.host})
                </p>
              </div>
            </div>
          </DialogHeader>

          {/* PILIHAN MODE TRANSAKSI: OUT (- STOK, TIDAK PERNAH MINUS) VS IN (+ STOK) */}
          <div className="space-y-1.5 pt-1">
            <label className="text-xs font-bold text-foreground">
              Aksi Transaksi Terhadap Stok DB:
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setActionType("out");
                  setSalesChannel("Online (Marketplace/Web)");
                }}
                className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border text-xs font-bold transition-all ${
                  actionType === "out"
                    ? "border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400 ring-2 ring-red-500/20"
                    : "border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted/60"
                }`}
              >
                <ArrowDownRight className="h-4 w-4 text-red-500" />
                <span>OUT (Mengurangi Stok - Max 0)</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setActionType("in");
                  setSalesChannel("Gudang");
                }}
                className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border text-xs font-bold transition-all ${
                  actionType === "in"
                    ? "border-green-500/50 bg-green-500/10 text-green-600 dark:text-green-400 ring-2 ring-green-500/20"
                    : "border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted/60"
                }`}
              >
                <ArrowUpRight className="h-4 w-4 text-green-500" />
                <span>IN (Menambahkan Stok)</span>
              </button>
            </div>
            {actionType === "out" && (
              <p className="text-[10px] text-muted-foreground flex items-center gap-1 mt-1">
                <ShieldAlert className="h-3 w-3 text-emerald-600 shrink-0" />
                <span>Perlindungan Stok: Kueri menggunakan <strong>GREATEST(0, stock - qty)</strong> sehingga stok <strong>tidak akan pernah minus</strong>.</span>
              </p>
            )}
          </div>

          {/* INPUT FORM: TANGGAL & SALES CHANNEL & NAMA PRODUK */}
          <div className="space-y-3 pt-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* PILIHAN TANGGAL */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-foreground flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5 text-primary" />
                  <span>Tanggal Transaksi</span>
                </label>
                <input
                  type="date"
                  value={saveDate}
                  onChange={(e) => setSaveDate(e.target.value)}
                  className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs font-bold text-primary shadow-xs focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>

              {/* SALES CHANNEL / SUPPLIER */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-foreground flex items-center gap-1.5">
                  <ShoppingBag className="h-3.5 w-3.5 text-primary" />
                  <span>{actionType === "out" ? "Sales Channel" : "Supplier Name"}</span>
                </label>
                <input
                  type="text"
                  value={salesChannel}
                  onChange={(e) => setSalesChannel(e.target.value)}
                  className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs font-semibold text-foreground shadow-xs focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  placeholder={actionType === "out" ? "Online (Marketplace/Web)" : "Gudang"}
                />
              </div>
            </div>

            {/* NAMA PRODUK */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-foreground flex items-center justify-between">
                <span>Nama Produk Target</span>
                <Edit3 className="h-3 w-3 text-muted-foreground" />
              </label>
              <input
                type="text"
                value={targetProductName}
                onChange={(e) => setTargetProductName(e.target.value)}
                className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs font-semibold shadow-xs focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                placeholder="Masukkan nama produk..."
              />
            </div>
          </div>

          {/* STANDARD SIZES SLOTS 1, 5, 20, 25 SUMMARY */}
          <div className="mt-1 space-y-1.5">
            <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
              Rekap Transaksi ({actionType.toUpperCase()}) Ukuran 1, 5, 20, 25:
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {["1", "5", "20", "25"].map((sz) => {
                const qty = mappedStandardSizes[sz] ?? 0;
                return (
                  <div
                    key={sz}
                    className={`rounded-xl border p-2.5 text-center transition-all ${
                      qty > 0
                        ? actionType === "out"
                          ? "border-red-500/40 bg-red-500/5 text-red-600 font-bold shadow-xs"
                          : "border-green-500/40 bg-green-500/5 text-green-600 font-bold shadow-xs"
                        : "border-border/60 bg-muted/20 text-muted-foreground"
                    }`}
                  >
                    <p className="text-[10px] uppercase tracking-wide opacity-80">Ukuran {sz}</p>
                    <p className="text-lg font-black tabular-nums mt-0.5">
                      {actionType === "out" ? "-" : "+"}{qty}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* SINGLE MAIN ACTION BUTTON */}
          <div className="pt-2 space-y-2">
            <Button
              onClick={handleDownloadAndSaveSql}
              className="w-full font-bold text-xs sm:text-sm gap-2 h-11 rounded-xl shadow-md"
              style={{ background: "var(--gradient-primary)" }}
            >
              <Save className="h-4 w-4" /> Simpan & Ekspor ke DB Inventory ({saveDate})
            </Button>

            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={handleCopySql}
                className="flex-1 font-bold text-xs gap-1.5 h-9 rounded-xl border-border/80"
              >
                {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                {copied ? "Query Disalin!" : "Salin Query MySQL"}
              </Button>
              <Button
                variant="secondary"
                asChild
                className="flex-1 text-xs font-semibold gap-1.5 h-9 rounded-xl"
              >
                <a href="https://inventoryaspal.vercel.app/" target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3.5 w-3.5 text-primary" /> Buka App Inventory
                </a>
              </Button>
            </div>
          </div>



          <DialogFooter className="mt-2 pt-2 border-t border-border/50">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSaveModalOpen(false)}
              className="w-full sm:w-auto text-xs"
            >
              Batal / Tutup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

{/* SIZE CARD ACCORDION COMPONENT */}
function SizeCard({
  s,
  isExpanded,
  onToggle,
}: {
  s: { size: string; items: { name: string; qty: number }[]; totalQty: number };
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const [expandedItemIdxs, setExpandedItemIdxs] = useState<Record<number, boolean>>({});

  const toggleItem = (idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedItemIdxs((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  return (
    <Card className="overflow-hidden border border-border/70 shadow-xs hover:shadow-md transition-all rounded-xl sm:rounded-2xl">
      {/* ACCORDION HEADER (MINIMIZED BY DEFAULT) */}
      <div
        onClick={onToggle}
        className="flex cursor-pointer select-none items-center justify-between px-3.5 py-3 sm:px-5 sm:py-4 text-primary-foreground transition-all active:opacity-90"
        style={{ background: "var(--gradient-primary)" }}
      >
        <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
          <div className="flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-lg sm:rounded-xl bg-white/20 backdrop-blur shrink-0">
            <Ruler className="h-4 w-4 sm:h-5 sm:w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-base sm:text-lg font-black tracking-tight">{s.size}</p>
              <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] sm:text-xs font-semibold backdrop-blur">
                {s.items.length} produk
              </span>
            </div>
            <p className="text-[10px] opacity-80 sm:text-xs font-medium">
              {isExpanded ? "Ketuk untuk minimize" : "Ketuk untuk tampilkan rincian"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 sm:gap-4 shrink-0">
          <div className="text-right">
            <p className="text-[9px] sm:text-xs uppercase tracking-wider opacity-85 font-semibold">Total Qty</p>
            <p className="text-lg sm:text-2xl font-black tabular-nums leading-none">{s.totalQty}</p>
          </div>
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 backdrop-blur shrink-0 transition-transform">
            {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </div>
        </div>
      </div>

      {/* ITEMS LIST (EXPANDABLE) */}
      {isExpanded && (
        <CardContent className="p-0 bg-card">
          <ul className="divide-y divide-border/40">
            {s.items.map((it, j) => {
              const isItemExpanded = !!expandedItemIdxs[j];
              return (
                <li
                  key={j}
                  onClick={(e) => toggleItem(j, e)}
                  className="flex cursor-pointer items-start justify-between gap-3 px-3.5 py-3 sm:px-5 sm:py-3.5 transition-colors hover:bg-muted/40 active:bg-muted/70"
                >
                  <div className="min-w-0 flex-1">
                    {/* TRUNCATED DESCRIPTIONS BY DEFAULT FOR COMPACT MOBILE VIEW */}
                    <p
                      className={`text-xs sm:text-sm font-medium leading-snug text-foreground transition-all ${
                        isItemExpanded ? "" : "line-clamp-2"
                      }`}
                    >
                      {it.name}
                    </p>
                    <span className="mt-1 inline-block text-[10px] text-primary font-semibold hover:underline">
                      {isItemExpanded ? "▲ Sembunyikan" : "▼ Lihat nama lengkap"}
                    </span>
                  </div>
                  <Badge
                    variant="secondary"
                    className="tabular-nums shrink-0 border border-primary/20 bg-primary/10 text-primary font-extrabold px-2.5 py-1 text-xs sm:text-sm shadow-xs rounded-lg"
                  >
                    × {it.qty}
                  </Badge>
                </li>
              );
            })}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}

{/* PRODUCT CARD COMPONENT */}
function ProductCard({ g }: { g: GroupedProduct }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <Card className="overflow-hidden border border-border/60 shadow-xs hover:shadow-md transition-all rounded-xl sm:rounded-2xl">
      <CardContent className="p-3.5 sm:p-4">
        <div
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex cursor-pointer items-start justify-between gap-3"
        >
          <div className="flex items-start gap-2.5 sm:gap-3 min-w-0">
            <div className="mt-0.5 flex h-7 w-7 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Package className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            </div>
            <div className="min-w-0">
              <h3 className={`font-semibold text-xs sm:text-sm leading-snug ${isExpanded ? "" : "line-clamp-2"}`}>
                {g.name}
              </h3>
              <p className="mt-0.5 text-[10px] text-muted-foreground sm:text-xs">
                {g.variants.length} varian ukuran · {isExpanded ? "Sembunyikan" : "Lihat rincian"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="default" className="tabular-nums font-bold px-2.5 py-1 text-xs">
              Total {g.totalQty}
            </Badge>
            <div className="text-muted-foreground">
              {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </div>
          </div>
        </div>

        {isExpanded && (
          <div className="mt-3 pt-3 border-t border-border/50 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {g.variants.map((v, j) => (
              <div
                key={j}
                className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs"
              >
                <span className="font-bold text-primary">{v.size}</span>
                <span className="tabular-nums font-bold text-foreground/90">
                  × {v.qty}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatCard({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <Card
      className="border-0 overflow-hidden rounded-xl sm:rounded-2xl"
      style={{
        boxShadow: "var(--shadow-soft)",
        background: accent ? "var(--gradient-primary)" : undefined,
      }}
    >
      <CardContent className="p-3 sm:p-4">
        <div
          className={`flex items-center gap-1.5 text-[10px] sm:text-xs font-semibold uppercase tracking-wider ${
            accent ? "text-primary-foreground/85" : "text-muted-foreground"
          }`}
        >
          {icon}
          <span className="truncate">{label}</span>
        </div>
        <p
          className={`mt-1 text-xl sm:text-2xl font-black tabular-nums ${
            accent ? "text-primary-foreground" : "text-foreground"
          }`}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
