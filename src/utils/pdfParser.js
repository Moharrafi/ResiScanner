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
