// Browser-only PDF text extraction & product/size parser.
// Detects sizes embedded in product names (e.g. 5kg, 500g, 1L, 250ml, 20cm)
// and groups identical (name+size) items across pages, summing qty.

export type ProductCategory = "hitam" | "hijau" | "bitumax" | "lainnya";

export type ProductRow = {
  raw: string;
  name: string; // base name without size token
  sku?: string | null;
  category: ProductCategory;
  size: string | null; // normalized size, e.g. "5KG"
  qty: number;
  pageWeightSize?: string | null; // fallback weight extracted from shipping label (e.g. "1KG")
};

export type GroupedProduct = {
  name: string;
  category?: ProductCategory;
  sku?: string | null;
  variants: { size: string; qty: number }[];
  totalQty: number;
};

export type QtyTier = {
  qtyPerOrder: number; // e.g. 1, 2, 3...
  orderCount: number; // how many orders/packages have this qty
  totalQty: number; // qtyPerOrder * orderCount
  items: {
    raw: string;
    name: string;
    sku?: string | null;
    qty: number;
  }[];
};

export type CategorySizeGroup = {
  size: string; // e.g. "5KG"
  totalQty: number;
  totalOrders: number;
  qtyTiers: QtyTier[];
  items: {
    raw: string;
    name: string;
    sku?: string | null;
    qty: number;
  }[];
};

export type FlattenedTierItem = {
  key: string; // e.g. "1KG-1", "1KG-2"
  size: string; // "1KG"
  qtyPerOrder: number; // 1, 2, 3...
  label: string; // "1KG" if qty === 1 else "1KG (2)"
  orderCount: number; // e.g. 43
  totalQty: number; // e.g. 43 or 6
  items: {
    raw: string;
    name: string;
    sku?: string | null;
    qty: number;
  }[];
};

export type CategoryGroup = {
  category: ProductCategory;
  label: string; // "Hitam (Biasa)", "Hijau", "Bitumax", "Lainnya"
  skuPrefix: string; // "aspalcair*", "HIJAU*", "Bitumax*"
  totalQty: number;
  totalOrders: number;
  sizes: CategorySizeGroup[];
  tierItems: FlattenedTierItem[];
};

export function detectCategory(text: string, sku?: string | null): ProductCategory {
  const s = (sku ?? "").toLowerCase();
  const t = text.toLowerCase();

  // 1. Check SKU first (most specific and authoritative)
  if (s.includes("bitumax")) return "bitumax";
  if (s.includes("hijau") || s.includes("green")) return "hijau";
  if (s.includes("aspalcair") || s.includes("hitam") || s.includes("black")) return "hitam";

  // 2. Check product name text
  if (t.includes("bitumax")) return "bitumax";
  if (t.includes("hijau") || t.includes("green")) return "hijau";
  if (
    t.includes("hitam") ||
    t.includes("black") ||
    t.includes("aspalcair") ||
    t.includes("aspal cair") ||
    t.includes("aspal")
  ) {
    return "hitam";
  }

  // 3. Fallback to regular hitam
  return "hitam";
}

// Size units we care about (weight / volume / length / pack).
// Matches things like: 5kg, 5 kg, 1.5L, 500ml, 250 gr, 20cm, 12", 6pcs
const SIZE_UNIT_RE =
  /(\d+(?:[.,]\d+)?)\s*(kgs?|kilogram|gr(?:am)?s?|g|mg|l(?:iter|tr)?|ml|cc|cm|mm|m(?:eter)?|inch|in|"|pcs|pack|pak|roll|rol|sachet|sct)\b/gi;

function normalizeSize(num: string, unit: string): string {
  const u = unit.toLowerCase();
  const canonical: Record<string, string> = {
    kgs: "KG",
    kg: "KG",
    kilogram: "KG",
    g: "G",
    gr: "G",
    gram: "G",
    grams: "G",
    grs: "G",
    mg: "MG",
    l: "KG",
    liter: "KG",
    ltr: "KG",
    ml: "ML",
    cc: "CC",
    cm: "CM",
    mm: "MM",
    m: "M",
    meter: "M",
    inch: "IN",
    in: "IN",
    '"': "IN",
    pcs: "PCS",
    pack: "PACK",
    pak: "PACK",
    roll: "ROLL",
    rol: "ROLL",
    sachet: "SACHET",
    sct: "SACHET",
  };
  const cu = canonical[u] ?? u.toUpperCase();
  return `${num.replace(",", ".")}${cu}`;
}

function extractSizeFromName(name: string): { size: string | null; cleaned: string } {
  SIZE_UNIT_RE.lastIndex = 0;
  const matches = [...name.matchAll(SIZE_UNIT_RE)];
  if (matches.length === 0) return { size: null, cleaned: name };
  // Prefer weight/volume units when available, else first match.
  const priority = ["KG", "G", "L", "ML", "CC", "MG"];
  let pick = matches[0];
  for (const m of matches) {
    const norm = normalizeSize(m[1], m[2]).replace(/^[\d.]+/, "");
    if (priority.includes(norm)) {
      pick = m;
      break;
    }
  }
  const size = normalizeSize(pick[1], pick[2]);
  const cleaned = name
    .replace(pick[0], " ")
    .replace(/\s{2,}/g, " ")
    .replace(/[-–—,:;|]+\s*$/g, "")
    .trim();
  return { size, cleaned };
}

// Extracts total package weight in kg from page text (e.g., "Berat: 3000 gr" -> 3.0)
export function extractPageWeightInKg(textLines: string[]): number | null {
  const fullText = textLines.join(" ");

  // Matches:
  // - "Berat: 1000 gr", "Berat: 3000g", "Berat: 5 kg", "Weight: 5000 g"
  // - "Berat (gr): 3000", "Berat (kg): 5"
  // - "Berat: 3000"
  const weightRegex =
    /(?:Berat|Weight)\s*(?:\((kgs?|kilogram|gr(?:am)?s?|g)\))?\s*:?\s*(\d+(?:[.,]\d+)?)\s*(kgs?|kilogram|gr(?:am)?s?|g)?\b/i;

  const match = fullText.match(weightRegex);
  if (!match) return null;

  const parenUnit = match[1];
  const numRaw = match[2];
  const trailingUnit = match[3];

  if (!numRaw) return null;

  const num = parseFloat(numRaw.replace(",", "."));
  if (isNaN(num) || num <= 0) return null;

  const unit = (trailingUnit || parenUnit || "").toLowerCase();

  if (unit.startsWith("gr") || unit === "g" || unit.startsWith("gram")) {
    return num / 1000;
  } else if (unit.startsWith("kg") || unit.startsWith("kilogram")) {
    return num;
  } else {
    // Fallback: if number >= 100 assume grams (e.g. 3000 -> 3kg), else assume kg (e.g. 1, 5, 20)
    return num >= 100 ? num / 1000 : num;
  }
}

// Calculates single unit weight (Total Weight / Qty) and snaps to standard inventory sizes (1, 5, 20, 25 kg)
export function computeUnitWeightSize(totalWeightInKg: number | null, qty: number): string | null {
  if (totalWeightInKg == null || totalWeightInKg <= 0 || qty <= 0) return null;

  const unitWeight = totalWeightInKg / qty;

  // Snap to standard inventory sizes (1, 5, 20, 25 kg) with packaging tolerance buffers
  if (unitWeight >= 0.7 && unitWeight <= 1.4) return "1KG";
  if (unitWeight >= 3.5 && unitWeight <= 7.5) return "5KG";
  if (unitWeight >= 15.0 && unitWeight <= 22.0) return "20KG";
  if (unitWeight >= 22.1 && unitWeight <= 30.0) return "25KG";

  const cleanKgNum = Number(unitWeight.toFixed(3)).toString();
  return `${cleanKgNum}KG`;
}

type LineItem = { y: number; x: number; str: string; width: number };

export async function extractRowsFromPdf(
  file: File,
): Promise<{ name: string; sku?: string | null; qty: number; pageWeightSize?: string | null }[]> {
  const pdfjs: any = await import("pdfjs-dist/build/pdf.mjs");
  const workerSrc = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;

  const allRows: { name: string; sku?: string | null; qty: number; pageWeightSize?: string | null }[] = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();

    // Flatten items with positions
    const items: LineItem[] = (content.items as any[])
      .filter((it) => typeof it.str === "string" && it.str.trim() !== "")
      .map((it) => ({
        y: Math.round(it.transform[5]),
        x: it.transform[4],
        str: it.str,
        width: it.width ?? 0,
      }));

    // Cluster into rows by y (tolerance a few px)
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: LineItem[][] = [];
    for (const it of items) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(last[0].y - it.y) <= 3) last.push(it);
      else rows.push([it]);
    }

    // Extract text lines for this page to find "Berat: XXX gr/kg"
    const textLines = rows.map((r) =>
      [...r].sort((a, b) => a.x - b.x).map((it) => it.str).join(" "),
    );
    const pageWeightInKg = extractPageWeightInKg(textLines);

    const pageRows: { name: string; sku?: string | null; qty: number; pageWeightSize?: string | null }[] = [];

    // Detect the product table header on this page. Supports both formal table headers
    // ("Product Name", "Seller SKU", "Qty") and shipping label packing slips.
    let qtyX: number | null = null;
    let nameX: number | null = null;
    let skuX: number | null = null;
    let headerY: number | null = null;

    for (const row of rows) {
      const rowLine = row.map((r) => r.str).join(" ");
      const hasQty = row.find((r) => /^(qty|quantity|jumlah|jml|total|pcs|kuantitas)$/i.test(r.str.trim()));
      const hasName = row.find((r) =>
        /^(product\s*name|nama\s*produk|item|product|nama\s*barang|deskripsi|description|rincian\s*produk)$/i.test(
          r.str.trim(),
        ),
      );
      // Check for SKU header (single token or split like "Seller" + "SKU")
      const hasSku =
        row.find((r) => /^(seller\s*sku|sku|no\.?\s*sku|kode\s*sku|sku\s*penjual)$/i.test(r.str.trim())) ||
        (/seller/i.test(rowLine) && /sku/i.test(rowLine)
          ? row.find((r) => /sku/i.test(r.str)) || row.find((r) => /seller/i.test(r.str))
          : null);

      if (hasQty && (hasName || hasSku)) {
        qtyX = hasQty.x;
        nameX = hasName ? hasName.x : hasSku!.x;
        if (hasSku) skuX = hasSku.x;
        headerY = row[0].y;
        break;
      } else if (hasSku && !hasQty) {
        skuX = hasSku.x;
        nameX = hasName ? hasName.x : hasSku.x;
        headerY = row[0].y;
        break;
      }
    }

    if (headerY != null) {
      // Only consider rows below the header
      const bodyRows = rows.filter((r) => r[0].y < headerY!);

      let current: { name: string; sku?: string | null; qty: number; pageWeightInKg?: number | null } | null = null;

      const flush = () => {
        if (current && current.name.trim()) {
          const trimmedName = current.name.replace(/\s+/g, " ").trim();
          // Filter out table summary / footer text accidentally captured
          if (
            /^(qty\s*total|total\s*qty|total\s*item|total\s*unit|order\s*id|tt\s*order\s*id)/i.test(
              trimmedName,
            )
          ) {
            current = null;
            return;
          }
          const unitWeightSize = computeUnitWeightSize(current.pageWeightInKg ?? null, current.qty);
          let finalSku = current.sku ? current.sku.trim() : null;
          if (!finalSku) {
            const m = trimmedName.match(/\b(HIJAU\w*|aspalcair\w*|bitumax\w*)\b/i);
            if (m) finalSku = m[1];
          }
          pageRows.push({
            name: trimmedName,
            sku: finalSku,
            qty: current.qty,
            pageWeightSize: unitWeightSize,
          });
        }
        current = null;
      };

      for (const row of bodyRows) {
        const sorted = [...row].sort((a, b) => a.x - b.x);
        const rowText = sorted.map((r) => r.str).join(" ").trim();

        // Check if this row is a table summary / footer row (e.g. "Qty Total: 1", "Order ID: ...")
        const isFooterRow =
          /^(qty\s*total|total\s*qty|total\s*item|total\s*pesanan|total\s*barang|total\s*unit|total\s*:|subtotal|order\s*id|tt\s*order\s*id|no\.?\s*pesanan|no\.?\s*resi|tracking\s*no)\b/i.test(
            rowText,
          ) ||
          sorted.some((it) =>
            /^(qty\s*total:?|total\s*qty:?|total\s*item:?|total\s*:?|subtotal:?|order\s*id:?|tt\s*order\s*id:?|no\.?\s*pesanan:?)$/i.test(
              it.str.trim(),
            ),
          );

        if (isFooterRow) {
          flush();
          break; // Stop scanning table body once footer/summary row is reached
        }

        // Check if there's an integer cell for quantity
        const qtyCell =
          qtyX != null
            ? sorted.find((r) => Math.abs(r.x - qtyX!) < 80 && /^\d{1,4}$/.test(r.str.trim()))
            : sorted.find((r) => /^\d{1,3}$/.test(r.str.trim()) && r.x > (nameX ?? 0) + 40);

        // Scan all tokens in this row for explicit SKU patterns
        let skuFound: string | null = null;
        const skuMatch = rowText.match(/\b(HIJAU\w*|aspalcair\w*|bitumax\w*)\b/i);
        if (skuMatch) {
          skuFound = skuMatch[1];
        }

        // Text cells on this row (exclude only the qtyCell itself)
        const textCells = sorted.filter((r) => r !== qtyCell && r.x >= (nameX != null ? nameX - 25 : 0));
        const lineText = textCells.map((r) => r.str).join(" ").trim();

        if (qtyCell && (lineText || skuFound)) {
          flush();
          current = {
            name: (lineText || skuFound || "").replace(/\bDefault\b/g, " "),
            sku: skuFound,
            qty: parseInt(qtyCell.str.trim(), 10) || 1,
            pageWeightInKg,
          };
        } else if (current && (lineText || skuFound)) {
          // continuation of the previous product's multi-line name
          if (lineText) current.name += " " + lineText.replace(/\bDefault\b/g, " ");
          if (skuFound && !current.sku) current.sku = skuFound;
        } else if (!lineText && !qtyCell && !skuFound) {
          // empty tabular row between products
        }
      }
      flush();
    }

    // 2. FALLBACK SCANNER: If no rows were extracted by table parser, scan all text on this page
    // (Crucial for courier shipping labels where Seller SKU is printed without a formal table header)
    if (pageRows.length === 0) {
      for (const line of textLines) {
        const skuMatches = [
          ...line.matchAll(/\b(HIJAU\d*(?:KG|G|L)?|aspalcair\d*(?:kg|g|l)?|Bitumax\d*(?:kg|g|l)?)\b/gi),
        ];
        for (const sm of skuMatches) {
          const skuToken = sm[0];
          let qty = 1;
          const qtyMatch = line.match(/(?:x|qty|jml)\s*:?\s*(\d{1,3})\b/i);
          if (qtyMatch) {
            qty = parseInt(qtyMatch[1], 10) || 1;
          }
          const unitWeightSize = computeUnitWeightSize(pageWeightInKg ?? null, qty);

          pageRows.push({
            name: line.trim() || skuToken,
            sku: skuToken,
            qty,
            pageWeightSize: unitWeightSize,
          });
        }
      }
    }

    allRows.push(...pageRows);
  }

  return allRows;
}

export function parseProducts(
  raw: { name: string; sku?: string | null; qty: number; pageWeightSize?: string | null }[],
): {
  rows: ProductRow[];
  grouped: GroupedProduct[];
  categories: CategoryGroup[];
} {
  const rows: ProductRow[] = raw.map((r) => {
    let { size, cleaned } = extractSizeFromName(r.name);
    // If size not in product name, try from SKU
    if (!size && r.sku) {
      const fromSku = extractSizeFromName(r.sku);
      if (fromSku.size) size = fromSku.size;
    }
    const finalSize = size ?? r.pageWeightSize ?? null;

    let finalSku = r.sku ?? null;
    if (!finalSku) {
      const m = r.name.match(/\b(aspalcair\w*|hijau\w*|bitumax\w*)\b/i);
      if (m) finalSku = m[1];
    }

    const category = detectCategory(r.name, finalSku);

    return {
      raw: r.name,
      name: cleaned,
      sku: finalSku,
      category,
      size: finalSize,
      qty: r.qty,
      pageWeightSize: r.pageWeightSize,
    };
  });

  // 1. Group by (baseName + size), summing qty across pages (backward compatibility)
  const bySizeKey = new Map<string, { name: string; category: ProductCategory; sku?: string | null; size: string | null; qty: number }>();
  for (const r of rows) {
    const key = `${r.name.toLowerCase()}|${r.size ?? "-"}`;
    const existing = bySizeKey.get(key);
    if (existing) existing.qty += r.qty;
    else bySizeKey.set(key, { name: r.name, category: r.category, sku: r.sku, size: r.size, qty: r.qty });
  }

  // Then group by base name, listing variants per size
  const byName = new Map<string, GroupedProduct>();
  for (const v of bySizeKey.values()) {
    const key = v.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, { name: v.name, category: v.category, sku: v.sku, variants: [], totalQty: 0 });
    const g = byName.get(key)!;
    g.variants.push({ size: v.size ?? "-", qty: v.qty });
    g.totalQty += v.qty;
  }

  for (const g of byName.values()) {
    g.variants.sort((a, b) =>
      a.size.localeCompare(b.size, undefined, { numeric: true, sensitivity: "base" }),
    );
  }

  const grouped = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

  // 2. Build 3 standard categories: Hitam (Biasa), Hijau, Bitumax
  const standardCategories: { category: ProductCategory; label: string; skuPrefix: string }[] = [
    {
      category: "hitam",
      label: "Hitam (Biasa)",
      skuPrefix: "aspalcair*",
    },
    {
      category: "hijau",
      label: "Hijau",
      skuPrefix: "HIJAU*",
    },
    {
      category: "bitumax",
      label: "Bitumax",
      skuPrefix: "Bitumax*",
    },
  ];

  const categories: CategoryGroup[] = standardCategories.map((meta) => {
    const catRows = rows.filter((r) => r.category === meta.category);

    // Group catRows by size
    const sizeMap = new Map<string, ProductRow[]>();
    for (const r of catRows) {
      const szKey = r.size ?? "Tanpa Ukuran";
      if (!sizeMap.has(szKey)) sizeMap.set(szKey, []);
      sizeMap.get(szKey)!.push(r);
    }

    const sizes: CategorySizeGroup[] = [];
    for (const [szKey, sRows] of sizeMap.entries()) {
      const totalSizeQty = sRows.reduce((acc, r) => acc + r.qty, 0);
      const totalSizeOrders = sRows.length;

      // Group by qtyPerOrder (e.g. qty 1 vs qty 2 vs qty 3...)
      const tierMap = new Map<number, QtyTier>();
      for (const r of sRows) {
        if (!tierMap.has(r.qty)) {
          tierMap.set(r.qty, {
            qtyPerOrder: r.qty,
            orderCount: 0,
            totalQty: 0,
            items: [],
          });
        }
        const tier = tierMap.get(r.qty)!;
        tier.orderCount += 1;
        tier.totalQty += r.qty;
        tier.items.push({
          raw: r.raw,
          name: r.name,
          sku: r.sku,
          qty: r.qty,
        });
      }

      const qtyTiers = [...tierMap.values()].sort((a, b) => a.qtyPerOrder - b.qtyPerOrder);

      sizes.push({
        size: szKey,
        totalQty: totalSizeQty,
        totalOrders: totalSizeOrders,
        qtyTiers,
        items: sRows.map((r) => ({
          raw: r.raw,
          name: r.name,
          sku: r.sku,
          qty: r.qty,
        })),
      });
    }

    // Sort sizes naturally (1KG, 5KG, 20KG, 25KG, etc.)
    sizes.sort((a, b) =>
      a.size.localeCompare(b.size, undefined, { numeric: true, sensitivity: "base" }),
    );

    const totalCatQty = sizes.reduce((acc, s) => acc + s.totalQty, 0);
    const totalCatOrders = sizes.reduce((acc, s) => acc + s.totalOrders, 0);

    // Direct flattened list: 1KG, 1KG (2), 5KG, 5KG (2), etc.
    const tierItems: FlattenedTierItem[] = [];
    for (const sz of sizes) {
      for (const tier of sz.qtyTiers) {
        const label = tier.qtyPerOrder === 1 ? sz.size : `${sz.size} (${tier.qtyPerOrder})`;
        tierItems.push({
          key: `${sz.size}-${tier.qtyPerOrder}`,
          size: sz.size,
          qtyPerOrder: tier.qtyPerOrder,
          label,
          orderCount: tier.orderCount,
          totalQty: tier.totalQty,
          items: tier.items,
        });
      }
    }

    return {
      category: meta.category,
      label: meta.label,
      skuPrefix: meta.skuPrefix,
      totalQty: totalCatQty,
      totalOrders: totalCatOrders,
      sizes,
      tierItems,
    };
  });

  // Check if there are any unclassified rows (lainnya)
  const otherRows = rows.filter((r) => r.category === "lainnya");
  if (otherRows.length > 0) {
    const sizeMap = new Map<string, ProductRow[]>();
    for (const r of otherRows) {
      const szKey = r.size ?? "Tanpa Ukuran";
      if (!sizeMap.has(szKey)) sizeMap.set(szKey, []);
      sizeMap.get(szKey)!.push(r);
    }
    const sizes: CategorySizeGroup[] = [];
    for (const [szKey, sRows] of sizeMap.entries()) {
      const totalSizeQty = sRows.reduce((acc, r) => acc + r.qty, 0);
      const tierMap = new Map<number, QtyTier>();
      for (const r of sRows) {
        if (!tierMap.has(r.qty)) {
          tierMap.set(r.qty, {
            qtyPerOrder: r.qty,
            orderCount: 0,
            totalQty: 0,
            items: [],
          });
        }
        const tier = tierMap.get(r.qty)!;
        tier.orderCount += 1;
        tier.totalQty += r.qty;
        tier.items.push({ raw: r.raw, name: r.name, sku: r.sku, qty: r.qty });
      }
      sizes.push({
        size: szKey,
        totalQty: totalSizeQty,
        totalOrders: sRows.length,
        qtyTiers: [...tierMap.values()].sort((a, b) => a.qtyPerOrder - b.qtyPerOrder),
        items: sRows.map((r) => ({ raw: r.raw, name: r.name, sku: r.sku, qty: r.qty })),
      });
    }
    sizes.sort((a, b) =>
      a.size.localeCompare(b.size, undefined, { numeric: true, sensitivity: "base" }),
    );

    const tierItems: FlattenedTierItem[] = [];
    for (const sz of sizes) {
      for (const tier of sz.qtyTiers) {
        const label = tier.qtyPerOrder === 1 ? sz.size : `${sz.size} (${tier.qtyPerOrder})`;
        tierItems.push({
          key: `${sz.size}-${tier.qtyPerOrder}`,
          size: sz.size,
          qtyPerOrder: tier.qtyPerOrder,
          label,
          orderCount: tier.orderCount,
          totalQty: tier.totalQty,
          items: tier.items,
        });
      }
    }

    categories.push({
      category: "lainnya",
      label: "Lainnya",
      skuPrefix: "-",
      totalQty: sizes.reduce((acc, s) => acc + s.totalQty, 0),
      totalOrders: sizes.reduce((acc, s) => acc + s.totalOrders, 0),
      sizes,
      tierItems,
    });
  }

  return { rows, grouped, categories };
}


