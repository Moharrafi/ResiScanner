// Browser-only PDF text extraction & product/size parser.
// Detects sizes embedded in product names (e.g. 5kg, 500g, 1L, 250ml, 20cm)
// and groups identical (name+size) items across pages, summing qty.

export type ProductRow = {
  raw: string;
  name: string; // base name without size token
  size: string | null; // normalized size, e.g. "5KG"
  qty: number;
};

export type GroupedProduct = {
  name: string;
  variants: { size: string; qty: number }[];
  totalQty: number;
};

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

type LineItem = { y: number; x: number; str: string; width: number };

export async function extractRowsFromPdf(file: File): Promise<{ name: string; qty: number }[]> {
  const pdfjs: any = await import("pdfjs-dist/build/pdf.mjs");
  const workerSrc = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;

  const allRows: { name: string; qty: number }[] = [];

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

    // Detect the product table header on this page. We REQUIRE both a
    // "Product Name"-style column AND a "Qty"-style column; otherwise the
    // page is treated as non-tabular (e.g. shipping label) and skipped.
    let qtyX: number | null = null;
    let nameX: number | null = null;
    let headerY: number | null = null;
    for (const row of rows) {
      const hasQty = row.find((r) => /^(qty|quantity|jumlah|jml)$/i.test(r.str.trim()));
      const hasName = row.find((r) =>
        /^(product\s*name|nama\s*produk|item|product)$/i.test(r.str.trim()),
      );
      if (hasQty && hasName) {
        qtyX = hasQty.x;
        nameX = hasName.x;
        headerY = row[0].y;
        break;
      }
    }
    if (qtyX == null || nameX == null || headerY == null) continue; // no table on this page

    // Only consider rows below the header
    const bodyRows = rows.filter((r) => r[0].y < headerY!);

    let current: { name: string; qty: number } | null = null;

    const flush = () => {
      if (current && current.name.trim()) {
        allRows.push({ name: current.name.replace(/\s+/g, " ").trim(), qty: current.qty });
      }
      current = null;
    };

    for (const row of bodyRows) {
      const sorted = [...row].sort((a, b) => a.x - b.x);
      // qty cell: an integer token close to the Qty column x
      const qtyCell = sorted.find(
        (r) => Math.abs(r.x - qtyX!) < 60 && /^\d{1,4}$/.test(r.str.trim()),
      );
      // does this row have text in the name column?
      const nameHere = sorted.filter((r) => r.x >= nameX! - 20 && r.x < qtyX! - 120);
      const nameText = nameHere.map((r) => r.str).join(" ").trim();

      if (qtyCell && nameText) {
        flush();
        current = {
          name: nameText.replace(/\bDefault\b/g, " "),
          qty: parseInt(qtyCell.str.trim(), 10),
        };
      } else if (current && nameText) {
        // continuation of the previous product's multi-line name
        current.name += " " + nameText.replace(/\bDefault\b/g, " ");
      } else if (!nameText && !qtyCell) {
        // an entirely empty tabular row between products — end current entry
        // (but only if we actually left the table area)
      }
    }
    flush();
  }

  return allRows;
}

export function parseProducts(
  raw: { name: string; qty: number }[],
): { rows: ProductRow[]; grouped: GroupedProduct[] } {
  const rows: ProductRow[] = raw.map((r) => {
    const { size, cleaned } = extractSizeFromName(r.name);
    return { raw: r.name, name: cleaned, size, qty: r.qty };
  });

  // Group by (baseName + size), summing qty across pages
  const bySizeKey = new Map<string, { name: string; size: string | null; qty: number }>();
  for (const r of rows) {
    const key = `${r.name.toLowerCase()}|${r.size ?? "-"}`;
    const existing = bySizeKey.get(key);
    if (existing) existing.qty += r.qty;
    else bySizeKey.set(key, { name: r.name, size: r.size, qty: r.qty });
  }

  // Then group by base name, listing variants per size
  const byName = new Map<string, GroupedProduct>();
  for (const v of bySizeKey.values()) {
    const key = v.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, { name: v.name, variants: [], totalQty: 0 });
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
  return { rows, grouped };
}
