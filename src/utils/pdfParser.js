import * as pdfjsLib from 'pdfjs-dist';

// Set the worker source properly for Vite
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

/**
 * Parses a PDF file and extracts text.
 * @param {File} file - The PDF file object.
 * @returns {Promise<{text: string, items: string[]}>} - A promise resolving to the full text and extracted items.
 */
export const parsePDF = async (file) => {
  const fileReader = new FileReader();

  return new Promise((resolve, reject) => {
    fileReader.onload = async (event) => {
      try {
        const typedarray = new Uint8Array(event.target.result);
        const pdf = await pdfjsLib.getDocument(typedarray).promise;
        let fullText = "";

        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          const pageText = textContent.items.map((item) => item.str).join(" ");
          fullText += pageText + "\n";
        }

        resolve(fullText);
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
 * patterns:
 * 1. Starts with "SPXID" (e.g., SPXID069874231161)
 * 2. Starts with "JX" (e.g., JX6874144911)
 * 3. 12-digit number (e.g., 570237122930) - top barcode
 * @param {string} text
 * @returns {string[]}
 */
export const extractResi = (text) => {
  const matches = [];

  // 1. Collapse spaces between digits: "5 7 0" -> "570"
  // This handles the issue where the PDF parser extracts each digit as a separate token with spaces.
  const collapsedText = text.replace(/(\d)\s+(?=\d)/g, '$1');

  // Normalize remaining text
  const normalizedText = collapsedText.replace(/\s+/g, ' ');

  // 1. SPXID pattern
  // Matches SPXID followed by 10-20 alphanumeric characters (limit to avoid merged text)
  const spxMatches = normalizedText.match(/\bSPXID[A-Z0-9]{10,20}\b/g) || [];
  matches.push(...spxMatches);

  // 2. JX pattern
  // Matches JX followed by 8-15 alphanumeric characters. (J&T usually 10-12 digits)
  const jxMatches = normalizedText.match(/\bJX[A-Z0-9]{8,15}\b/g) || [];
  matches.push(...jxMatches);

  // 3. 12-digit numeric pattern
  const potentialNumeric = normalizedText.match(/\b\d{12}\b/g) || [];

  const validNumeric = potentialNumeric.filter(num => {
    // Filter out common Indo phone number prefixes checks
    if (num.startsWith("08")) return false;
    if (num.startsWith("628")) return false;
    return true;
  });

  matches.push(...validNumeric);

  return [...new Set(matches)];
};
