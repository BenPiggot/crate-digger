/** Catalog numbers and runouts: keep only ASCII letters and digits. "SUB BASE-50-A1" → "subbase50a1" */
export function normalizeCode(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Barcodes: digits only. "5 022765 432501 >" → "5022765432501" */
export function digitsOnly(text: string): string {
    return text.replace(/\D/g, "");
}

/** Names and free text: keep letters and digits in any script, and drop accents. "Électro-Disques" → "electrodisques" */
export function normalizeText(text: string): string {
    return text
        .normalize("NFD") // split "É" into "E" + a combining accent mark
        .replace(/\p{M}/gu, "") // remove the accent marks
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, ""); // keep letters and digits from any script
}
