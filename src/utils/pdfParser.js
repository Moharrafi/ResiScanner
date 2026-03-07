import * as pdfjsLib from 'pdfjs-dist';
import { createWorker } from 'tesseract.js';

// Set the worker source properly for Vite
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

/**
 * Renders a PDF page to a canvas and returns the image data URL.
 * @param {Object} page - pdfjs page object
 * @param {number} scale - render scale (higher = better OCR accuracy)
 * @returns {Promise<string>} - image data URL
 */
const renderPageToImage = async (page, scale = 2.5) => {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL('image/png');
};

/**
 * Parses a PDF file and extracts text.
 * Falls back to OCR (tesseract.js) if the page appears to be image-based.
 * @param {File} file - The PDF file object.
 * @param {Function} onProgress - Callback for OCR progress: (pageNum, totalPages, status)
 * @returns {Promise<string>} - the full extracted text
 */
export const parsePDF = async (file, onProgress) => {
  const fileReader = new FileReader();

  return new Promise((resolve, reject) => {
    fileReader.onload = async (event) => {
      try {
        const typedarray = new Uint8Array(event.target.result);
        const pdf = await pdfjsLib.getDocument(typedarray).promise;
        let fullText = '';
        let needsOCR = false;
        const pageTexts = [];

        // --- Pass 1: Try native text extraction ---
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          const pageText = textContent.items.map((item) => item.str).join(' ');
          pageTexts.push({ page, pageText });
          fullText += pageText + '\n';
        }

        // Check if text extraction was meaningful.
        // If the whole text has fewer than 20 chars, it's probably image-based.
        const meaningfulText = fullText.replace(/\s+/g, '').length;
        if (meaningfulText < 20) {
          needsOCR = true;
        }

        if (!needsOCR) {
          resolve(fullText);
          return;
        }

        // --- Pass 2: OCR fallback with tesseract.js ---
        let ocrText = '';
        const worker = await createWorker('ind+eng', 1, {
          // Suppress verbose logger
          logger: () => { },
        });

        for (let i = 0; i < pageTexts.length; i++) {
          if (onProgress) {
            onProgress(i + 1, pageTexts.length, 'ocr');
          }
          const imageDataUrl = await renderPageToImage(pageTexts[i].page);
          const { data: { text } } = await worker.recognize(imageDataUrl);
          ocrText += text + '\n';
        }

        await worker.terminate();

        if (onProgress) {
          onProgress(pageTexts.length, pageTexts.length, 'done');
        }

        resolve(ocrText);
      } catch (error) {
        reject(error);
      }
    };

    fileReader.onerror = (error) => reject(error);
    fileReader.readAsArrayBuffer(file);
  });
};

/**
 * Extracts potential receipts/Order IDs from text.
 * Supported patterns:
 * 1. SPXID... (Shopee SPX)
 * 2. JX.../JP... (J&T Express) - JX/JP + exactly 10 digits
 * 3. 12-digit numeric (Shopee barcode top, e.g. 570309181306)
 * 4. 18-digit Shopee Order ID (e.g. 582902095838938167)
 * @param {string} text
 * @returns {string[]}
 */
export const extractResi = (text) => {
  const matches = [];

  // Normalize line endings only — keep spaces intact to avoid merging tokens
  const cleanText = text.replace(/\r/g, '');

  // ============================================================
  // 1. SPXID pattern (Shopee SPX)
  //    Strategy A: compact "SPXID063804848773" (most common)
  //    Strategy B: spaced "S P X I D 0 6 3 ..." (char-split PDF)
  // ============================================================
  // A: compact — word boundary prevents merging multiple tokens
  const spxCompact = cleanText.match(/\bSPXID[A-Z0-9]{10,20}\b/gi) || [];
  spxCompact.forEach(m => matches.push(m.toUpperCase()));

  // B: spaced chars — require a space BETWEEN each char to avoid cross-token merging
  const spxSpaced = [...cleanText.matchAll(/\bS P X I D(?: [A-Z0-9]){10,20}/gi)];
  spxSpaced.forEach(m => {
    const clean = m[0].replace(/\s+/g, '').toUpperCase();
    if (/^SPXID[A-Z0-9]{10,20}$/.test(clean)) matches.push(clean);
  });

  // ============================================================
  // 2. J&T resi: JX, JP, or JT prefix + 10-12 digits
  //    Strategy A: compact "JX7442075980", "JT69522083637"
  //    Strategy B: spaced "J X 7 4 4 2 ..."  (char-split PDF)
  // ============================================================
  // A: compact — no \s* inside digits, so it cannot cross a space into next token
  const jxCompact = [...cleanText.matchAll(/\bJ[XPT]\d{10,12}(?!\d)/gi)];
  jxCompact.forEach(m => {
    const clean = m[0].toUpperCase();
    if (/^J[XPT]\d{10,12}$/.test(clean)) matches.push(clean);
  });

  // B: spaced chars — require explicit space between each char
  const jxSpaced = [...cleanText.matchAll(/\bJ [XPT](?: \d){10,12}/gi)];
  jxSpaced.forEach(m => {
    const clean = m[0].replace(/\s+/g, '').toUpperCase();
    if (/^J[XPT]\d{10,12}$/.test(clean)) matches.push(clean);
  });

  // ============================================================
  // 3. 12-digit numeric (Shopee tracking barcode, e.g. 570309181306)
  //    Multi-pass collapse for spaced digits, then match exactly 12.
  //    Lookbehind (?<![A-Za-z0-9]) ensures we skip numbers that are
  //    part of larger alphanumeric codes like SPXID063...
  // ============================================================
  let digitText = cleanText;
  // Multiple passes to handle long spaced sequences like "5 7 0 3 0 9 ..."
  for (let i = 0; i < 15; i++) {
    digitText = digitText.replace(/(\d) (\d)/g, '$1$2');
  }
  const twelveDigits = [...digitText.matchAll(/(?<![A-Za-z0-9])\d{12}(?!\d)/g)];
  twelveDigits.forEach(m => {
    const num = m[0];
    if (!num.startsWith('08') && !num.startsWith('628')) {
      matches.push(num);
    }
  });

  // Deduplicate and return
  return [...new Set(matches)];
};


/**
 * Extracts package weights from labeled fields in shipment label PDFs.
 * Returns one weight string per shipment found.
 *
 * Supported formats:
 * 1. Shopee FastTrack : "Weight   ： 5 KG"
 * 2. J&T EZ          : "1.000 KG" (Indonesian thousands sep: 1.000 = 1,000 g = 1 kg)
 * 3. Berat label     : "Berat: 5000 gr" / "Berat: 5 KG"
 * 4. J&T Tokopedia   : "Berat:  5000 gr"
 *
 * @param {string} text
 * @returns {string[]} - e.g. ["5kg", "5kg", "1kg", "1kg"]
 */
export const extractWeights = (text) => {
  const results = [];

  const toDisplay = (grams) => {
    if (grams >= 1000 && grams % 1000 === 0) return `${grams / 1000}kg`;
    return `${grams}g`;
  };

  const addGrams = (grams) => {
    if (grams >= 10 && grams <= 100000) results.push(toDisplay(grams));
  };

  // Normalize: collapse multiple spaces/newlines into single space
  const t = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');

  // ----------------------------------------------------------------
  // 1. Shopee-style labeled weight: "Weight : 5 KG" or "Weight：5 KG"
  //    Each occurrence = one shipment
  // ----------------------------------------------------------------
  const shopee = [...t.matchAll(/Weight\s*[：:]\s*(\d+(?:[.,]\d+)?)\s*(KG|kg)/gi)];
  shopee.forEach(m => {
    const val = parseFloat(m[1].replace(',', '.'));
    addGrams(val * 1000);
  });

  // ----------------------------------------------------------------
  // 2. J&T EZ style: "1.000 KG" (digit DOT exactly-3-digits SPACE KG)
  //    Indonesian format: period = thousands separator
  //    So 1.000 KG = 1,000 grams = 1 kg
  //    Runs independently — patterns don't overlap with pattern 1.
  // ----------------------------------------------------------------
  const jt = [...t.matchAll(/\b(\d+)\.(\d{3})\s*KG\b/gi)];
  jt.forEach(m => {
    // m[1] = "1", m[2] = "000" → 1 kg
    const kg = parseInt(m[1]);
    addGrams(kg * 1000);
  });

  // ----------------------------------------------------------------
  // 3. "Berat: X gr" or "Berat: X KG" (J&T Tokopedia, Sicepat, etc.)
  //    Handles comma/dot decimal separators
  // ----------------------------------------------------------------
  const berat = [...t.matchAll(/\bBerat\s*[：:]\s*(\d+(?:[.,]\d+)?)\s*(KG|kg|gr|gram)\b/gi)];
  berat.forEach(m => {
    const val = parseFloat(m[1].replace(',', '.'));
    const isKg = m[2].toLowerCase().startsWith('k');
    addGrams(isKg ? val * 1000 : val);
  });

  // ----------------------------------------------------------------
  // 4. Standalone "X gr" (JTR format: Berat label is separated from value)
  //    e.g. "Berat:   COD: Batas Kirim: ... 5000 gr"
  //    Requires space before "gr" (product names use compact "5kg"/"1kg")
  //    Min 3 digits to avoid matching page numbers or short codes.
  //    toDisplay() converts 1000g→1kg, 5000g→5kg automatically.
  // ----------------------------------------------------------------
  const standaloneGr = [...t.matchAll(/\b(\d{3,6})\s+gr\b/gi)];
  standaloneGr.forEach(m => {
    const val = parseInt(m[1]);
    addGrams(val);
  });

  return results;
};

/**
 * Extracts per-resi product breakdown: for each shipment block, find individual items
 * and their sizes (e.g., 5kg, 1kg).
 *
 * @param {string} text
 * @returns {{ resiWeight: string, items: { type: 'bitumax' | 'biasa', size: string }[] }[]}
 */
export const extractProductName = (text) => {
  const t = text.replace(/\r/g, '');
  const lines = t.split('\n');

  const extractItemSize = (line) => {
    // Look for numbers followed by units (kg, liter, l, gr, gram, ml, lt)
    const m = line.match(/(\d+(?:[.,]\d+)?)\s*(kg|liter|l|gr|gram|ml|lt)/i);
    if (m) {
      let val = parseFloat(m[1].replace(',', '.'));
      let unit = m[2].toLowerCase();

      // Standardize to KG
      if (unit === 'gr' || unit === 'gram') {
        return `${val / 1000}kg`;
      }
      if (unit === 'ml') {
        return `${val / 1000}kg`;
      }
      if (unit === 'liter' || unit === 'l' || unit === 'lt') {
        return `${val}kg`;
      }

      // Default KG
      return `${val}kg`;
    }
    return null;
  };

  const weightAnchors = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/\s+/g, ' ').trim();
    const m1 = l.match(/(?:Weight|Pe\s*ne\s*rima)\s*[：:]\s*(\d+(?:[.,]\d+)?)\s*(KG|kg)/i);
    if (m1) {
      weightAnchors.push({ lineIdx: i, weightLabel: `${parseFloat(m1[1].replace(',', '.'))}kg` });
      continue;
    }
    const m2 = l.match(/(?:\b|^)(\d+)\.(\d{3})\s*KG\b/i);
    if (m2) {
      weightAnchors.push({ lineIdx: i, weightLabel: `${parseInt(m2[1])}kg` });
      continue;
    }
    const m3 = l.match(/Berat\s*[：:]\s*(\d+(?:[.,]\d+)?)\s*(KG|kg|gr|gram)/i);
    if (m3) {
      const val = parseFloat(m3[1].replace(',', '.'));
      const isKg = m3[2].toLowerCase().startsWith('k');
      const label = isKg ? `${val}kg` : `${val / 1000}kg`;
      weightAnchors.push({ lineIdx: i, weightLabel: label });
      continue;
    }
  }

  if (weightAnchors.length === 0) {
    lines.forEach((l, i) => {
      const m = l.match(/\b(\d+(?:[.,]\d+)?)\s*(KG|kg)\b/i);
      if (m) {
        const kg = parseFloat(m[1].replace(',', '.'));
        if (kg >= 0.1 && kg <= 100) weightAnchors.push({ lineIdx: i, weightLabel: `${kg}kg` });
      }
    });
  }

  if (weightAnchors.length === 0) return [];

  const blocks = [];
  for (let i = 0; i < weightAnchors.length; i++) {
    const anchor = weightAnchors[i];
    const start = anchor.lineIdx;
    const end = (i < weightAnchors.length - 1) ? weightAnchors[i + 1].lineIdx - 1 : lines.length - 1;

    // Find ALL IDs in this block or nearby context (Resi numbers + Order IDs)
    // Looking slightly above the weight label is good as IDs often sit there.
    const contextStart = Math.max(0, start - 15);
    const contextEnd = Math.min(lines.length - 1, end + 2);
    const contextText = lines.slice(contextStart, contextEnd + 1).join('\n');
    const orderIds = extractResi(contextText);

    blocks.push({ weightLabel: anchor.weightLabel, startLine: start, endLine: end, orderIds });
  }

  // Also handle the potential for lines after the last weight anchor
  // (though usually we capture everything up to each anchor)
  // If the last anchor is far from the end, maybe add one more block?
  // No, usually we want lines *above* the weight.

  const results = [];
  const extractMultipleSizes = (text) => {
    const results = [];
    // Added word boundaries \b to prevent partial matches of long IDs
    const regex = /\b(\d+(?:[.,]\d+)?)\s*(kg|liter|l|gr|gram|ml|lt)\b/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
      let val = match[1].replace(',', '.');
      // Limit value length to prevent crazy numbers
      if (val.length > 5) continue;

      let unit = match[2].toLowerCase();
      if (unit === 'l' || unit === 'lt') unit = 'liter';
      if (unit === 'kg' && parseFloat(val) >= 1) {
        results.push(parseFloat(val) + "kg");
      } else {
        results.push(val + unit);
      }
    }
    return results;
  };

  const extractQty = (text) => {
    // 1. Explicit prefixes: default, jumlah, qty, pcs, quantity
    const m1 = text.match(/(?:default|jumlah|qty|pcs|quantity)\s*[:：]?\s*(\d{1,3})\b/i);
    if (m1) return parseInt(m1[1]);

    // 2. The 'x' prefix: Only allow for small numbers (usually 1-10) 
    // to avoid capturing J&T routing codes like "B06 x 698"
    const mx = text.match(/\bx\s*(\d{1,3})\b/i);
    if (mx) {
      const val = parseInt(mx[1]);
      if (val <= 10) return val;
    }

    // 3. For trailing numbers, be very strict: only 1-2 digits
    const m2 = text.match(/\s+(\d{1,2})\s*$/);
    if (m2) {
      const val = parseInt(m2[1]);
      // Blacklist common J&T routing codes that might appear trailing
      if ([698, 699, 700].includes(val)) return 1;
      return val;
    }

    return 1;
  };

  const noisePatterns = [
    /product\s*name|nama\s*produk|item\s*name|deskripsi|nama\s*barang/gi,
    /sku|seller\s*sku|qty/gi,
    /tokopedia|shopee|lazada|shop/gi,
    /order\s*id\s*[:：]?\s*\d+/gi,
    /resi\s*[:：]?\s*[A-Z0-9]+/gi,
    /weight\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*(KG|kg)/gi,
    /berat\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*(KG|kg|gr|gram)/gi,
    /(\d+)\.(\d{3})\s*KG/gi,
    /qty\s*total\s*[:：]?\s*\d+/gi,
    /---\s*file\s*\d+\s*---/gi,
    /penerima|pengirim|jumlah|barang|syarat\s*dan\s*ketentuan/gi,
    /jalan|blok|no\s*[\d.]+|rt\s*[\d.]+|rw\s*[\d.]+|kel\.|kec\./gi,
    /www\.[a-z.]+/gi,
    /\(\+62\)\d+/gi,
    /\b[A-Z]{2,3}\d{10,20}\b/g, // Specific Resi formats like JX...
    /\b\d{15,25}\b/g, // Long numeric strings (Order IDs)
    /\b69[89]\b|\b700\b/g // J&T Routing codes False Positives
  ];

  for (const block of blocks) {
    const blockLines = lines.slice(block.startLine, block.endLine + 1);
    let rawItems = [];
    let currentBuffer = "";

    for (let i = 0; i < blockLines.length; i++) {
      const line = blockLines[i];
      const lower = line.toLowerCase();
      const normalizedStrip = lower.replace(/[\s:-]+/g, '');

      // Enhanced noise detection for Resi-like strings and metadata
      const hasLongId = /\b[A-Z]{2,3}\d{10,20}\b/i.test(line) || /\b\d{15,25}\b/.test(line);
      const isMetadataLine = /intransitby|orderid|resi:|weight:|pe\s*ne\s*rima/i.test(normalizedStrip);

      const isStrongNoise = /syaratdanketentuan|website|jet\.co\.id|jalan|blok|rt[\d.]|rw[\d.]/i.test(normalizedStrip) ||
        /official\s*store|bitumax\s*official|instagram/i.test(lower) || hasLongId || isMetadataLine;

      const isHeaderOrBanner = /tokopedia|shopee|lazada|shop|orderid|resi:|weight:|berat:|total|qtytotal|---|productname|namaproduk|itemname|deskripsi|namabarang|sellersku|sku|qty|store/i.test(normalizedStrip);

      // Heuristic for metadata like "Default" or "SKU X"
      const isMetaKeyword = /default|sku\s*\d|qty\s*\d/i.test(lower);

      // IMPORTANT: If the line contains a "strong" product indicator (like BituMax),
      // we DON'T skip it entirely even if it has noise attributes.
      const isStrongProductLine = /bitu\s*max|aspal\s*cair|premium\s*asphalt|bitumen|emulsion/i.test(lower);

      if ((isStrongNoise || (isHeaderOrBanner && !isMetaKeyword)) && !isStrongProductLine) {
        if (currentBuffer) rawItems.push(currentBuffer);
        currentBuffer = "";
        continue;
      }

      let cleaned = line;
      noisePatterns.forEach(p => { cleaned = cleaned.replace(p, ''); });
      cleaned = cleaned.trim();
      if (cleaned.length < 3) continue;

      const isStrongStart = /bitu\s*max|aspal\s*cair|premium\s*asphalt|aspal\s*anti\s*bocor|bitumen|emulsion/i.test(lower);
      const bufferHasEndMarker = /default|sku/i.test(currentBuffer);

      if (isStrongStart && currentBuffer && bufferHasEndMarker) {
        rawItems.push(currentBuffer);
        currentBuffer = cleaned;
      } else if (!currentBuffer) {
        currentBuffer = cleaned;
      } else {
        currentBuffer += " " + cleaned;
      }
    }
    if (currentBuffer) rawItems.push(currentBuffer);

    let items = rawItems
      .filter(txt => {
        const lt = txt.toLowerCase();
        const hasKeyword = /bitu\s*max|asphalt|bitumen|emulsion|aspal|cair|bocor|rembes|water\s*shield|paint|waterproofing|anti\s*bocor|anti\s*rembes/i.test(lt);
        const hasStructure = /default|sku\s*\d|qty\s*\d|jumlah\s*[:：]?\s*\d/i.test(lt);
        const hasSize = /\d+(?:[.,]\d+)?\s*(kg|liter|l|gr|gram|ml|lt)/i.test(lt);
        return txt.length > 5 && hasKeyword && (hasStructure || hasSize);
      })
      .flatMap(txt => {
        const lt = txt.toLowerCase();
        const type = /bitu\s*max/i.test(lt) ? 'bitumax' : 'biasa';
        const qty = extractQty(txt);
        const rawSizes = extractMultipleSizes(txt);
        const sizes = [...new Set(rawSizes)];

        if (sizes.length === 0) {
          return [{ type, size: block.weightLabel, qty }];
        }

        if (sizes.length > 1 && qty === 1) {
          return sizes.map(s => ({ type, size: s, qty: 1 }));
        }

        return [{ type, size: sizes[0], qty }];
      });

    // --- PER-BLOCK DEDUPLICATION ---
    // Deduplicate by SIZE + TYPE to allow e.g. "5L Bitumax" and "1L Bitumax"
    // but prevent OCR double-scans of the exact same product.
    const itemsByKey = {};
    items.forEach(item => {
      const key = `${item.size}|${item.type}`;
      if (!itemsByKey[key]) {
        itemsByKey[key] = item;
      }
    });
    items = Object.values(itemsByKey);

    if (items.length > 0) {
      results.push({ resiWeight: block.weightLabel, items, orderIds: block.orderIds });
    } else {
      results.push({ resiWeight: block.weightLabel, items: [{ type: 'biasa', size: block.weightLabel, qty: 1 }], orderIds: block.orderIds });
    }
  }

  return results.map(res => ({
    resiWeight: res.resiWeight,
    items: res.items,
    orderIds: res.orderIds
  }));
};


