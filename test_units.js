
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

console.log("1000GR ->", extractItemSize("Aspal Cair 1000GR"));
console.log("500GR ->", extractItemSize("Aspal Cair 500GR"));
console.log("5 Liter ->", extractItemSize("Bitumax 5 Liter"));
console.log("1 Liter ->", extractItemSize("Bitumax 1 Liter"));
console.log("1kg ->", extractItemSize("Aspal 1kg"));
