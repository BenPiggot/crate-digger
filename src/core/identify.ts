import { type RawVersion, type RawRelease, toRelease } from "./discogs.js";
import { 
    normalizeCode, digitsOnly, 
    normalizeText, missingValues,
    runoutWords, hasAllWords,
} from "./utils/text.js";

export interface PressingClues {
    // hard fact clues: safe to use for exclusion
    format?: string | undefined;
    country?: string | undefined;
    year?: string | undefined;

    // soft clues (used for ranking, but not excluding)
    label?: string | undefined;
    catno?: string | undefined;
    barcode?: string | undefined;
    runout?: string | undefined;
    details?: string | undefined;
}

type ClueKind = "catno" | "barcode" | "runout" | "details";

export interface IdentifyOptions {
    weights?: Partial<Record<ClueKind, number>>;
    confidenceMargin?: number;
}

export interface Candidate {
    version: RawVersion;
    release: RawRelease;
}

export interface RankedCandidate extends Candidate {
    score: number;
    // clues that matched this candidate
    matched: string[];
    // clues that did not match this candidate
    conflicts: string[];
}

export class PressingIdentifier {
    // Implementation for identifying pressings based on clues
    private readonly weights: Record<ClueKind, number>;
    private readonly runoutThreshold: number;
    private readonly confidenceMargin: number;

    constructor(options: IdentifyOptions = {}) {
        this.weights = {
            catno: 3,
            barcode: 5,
            runout: 5,
            details: 1,
            ...options.weights,
        };
        this.runoutThreshold = 0.8; // Example threshold for runout clue
        this.confidenceMargin = options.confidenceMargin ?? 3;
    }

    rank(clues: PressingClues, candidates: Candidate[]): RankedCandidate[] {
        return candidates
            .map((candidate) => this.score(clues, candidate))
            .sort((a, b) => b.score - a.score);
    }

    distinguishingCheck(
        clues: PressingClues,
        first: RankedCandidate,
        second: RankedCandidate,
    ): string | null {
        if (clues.runout === undefined) {
            const firstRunout = this.getIdentifiers(first.release, "Matrix / Runout");
            const secondRunout = this.getIdentifiers(second.release, "Matrix / Runout");
            if (firstRunout.length > 0 && secondRunout.length > 0) {
                const wordsFirst = runoutWords(firstRunout.join(" "));
                const wordsSecond = runoutWords(secondRunout.join(" "));
                const onlyFirst = [...wordsFirst].filter((w) => !wordsSecond.has(w));
                const onlySecond = [...wordsSecond].filter((w) => !wordsFirst.has(w));
                const printRunout = (release: RawRelease) => toRelease(release).runouts.join(" ");

                if (onlyFirst.length > 0 && onlySecond.length === 0) {
                    return `Is '${printRunout(first.release)}' etched in the runout, or only '${printRunout(second.release)}'?`;
                }
                if (onlySecond.length > 0 && onlyFirst.length === 0) {
                    return `Is '${printRunout(second.release)}' etched in the runout, or only '${printRunout(first.release)}'?`;
                }
                if (onlyFirst.length > 0 && onlySecond.length > 0) {
                    return `Which is etched in the runout: '${printRunout(first.release)}' or '${printRunout(second.release)}'?`;
                }
            }
        }
        if (clues.catno === undefined) {
            const firstCatno = (first.release.labels ?? [])
                .map((label) => label.catno ?? "")
                .filter((c) => c !== "" && c.toLowerCase() !== "none");
            const secondCatno = (second.release.labels ?? [])
                .map((label) => label.catno ?? "")
                .filter((c) => c !== "" && c.toLowerCase() !== "none");
            const onlyA = missingValues(firstCatno, secondCatno, normalizeCode);
            const onlyB = missingValues(secondCatno, firstCatno, normalizeCode);
            if (onlyA.length > 0 && onlyB.length > 0) {
                return `Which catalog number is printed on the record: ${onlyA[0]} or ${onlyB[0]}?`;
            }
        }

        if (clues.barcode === undefined) {
            const firstBarcode = this.getIdentifiers(first.release, "Barcode");
            const secondBarcode = this.getIdentifiers(second.release, "Barcode");
            const onlyA = missingValues(firstBarcode, secondBarcode, digitsOnly);
            const onlyB = missingValues(secondBarcode, firstBarcode, digitsOnly);
            if (onlyA.length > 0 && onlyB.length > 0) {
                return `Which barcode is on the sleeve: ${onlyA[0]} or ${onlyB[0]}?`;
            }
        }

        if (clues.details === undefined) {
            const firstDesc = toRelease(first.release).formats.flatMap((format) =>
                format.split(", "),
            );
            const secondDesc = toRelease(second.release).formats.flatMap((format) =>
                format.split(", "),
            );
            const extra =
                firstDesc.find((desc) => !secondDesc.includes(desc)) ??
                secondDesc.find((desc) => !firstDesc.includes(desc));
            if (extra !== undefined) {
                return `Is your copy described as: ${extra}? One of the two pressings is; the other is not.`;
            }
        }

        return null;
    }

    isConfident(candidates: RankedCandidate[]): boolean {
        const [first, second] = candidates;
        if (first === undefined || first.score <= 0) return false;
        if (second === undefined) return true;
        return first.score - second.score >= this.confidenceMargin;
    }

    private score(clues: PressingClues, c: Candidate): RankedCandidate {
        const result = { ...c, score: 0, matched: [] as string[], conflicts: [] as string[] };
        const r = toRelease(c.release);

        const check = (
            name: string,
            clue: string | undefined,
            values: string[],
            weight: number,
            norm: (s: string) => string,
        ) => {
            if (clue === undefined || values.length === 0) return; // no clue, or Discogs has no data
            if (values.map(norm).includes(norm(clue))) {
                result.score += weight;
                result.matched.push(`${name} '${clue}' matches`);
            } else {
                result.score -= weight;
                result.conflicts.push(`${name} '${clue}' doesn't match`);
            }
        };

        check(
            "catno",
            clues.catno,
            (c.release.labels ?? []).map((label) => label.catno ?? ""),
            this.weights.catno,
            normalizeCode,
        );
        check(
            "barcode",
            clues.barcode,
            this.getIdentifiers(c.release, "Barcode"),
            this.weights.barcode,
            digitsOnly,
        );

        const runouts = this.getIdentifiers(c.release, "Matrix / Runout");
        if (clues.runout !== undefined && runouts.length > 0) {
            const clue = normalizeCode(clues.runout);
            if (runouts.some((r) => hasAllWords(r, clue))){
                result.score += this.weights.runout;
                result.matched.push(`runout '${clues.runout}' matches`);
            } else {
                result.score -= this.weights.runout;
                result.conflicts.push(`runout '${clues.runout}' doesn't match`);
            }
        }

        const descriptions = normalizeText([...r.formats, c.release.notes ?? ""].join(" "));
        if (
            clues.details !== undefined &&
            descriptions.includes(normalizeText(clues.details ?? ""))
        ) {
            result.score += this.weights.details;
            result.matched.push(`'${clues.details}' appears in format description`);
        }

        return result;
    }

    private getIdentifiers(release: RawRelease, type: string = "Barcode") {
        return (release.identifiers ?? [])
            .filter((i) => i.type === type)
            .map((i) => i.value ?? "")
            .filter(Boolean);
    }
}
