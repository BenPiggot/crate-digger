import { type RawVersion, type RawRelease, toRelease } from "./discogs.js";
import { normalizeCode, digitsOnly, normalizeText } from "./utils/text.js";

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

export interface PressingMatch {
    release_id: number;
    score: number;
    matched: string[];
    conflicts: string[];
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

    constructor(options: IdentifyOptions = { }) {
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

    distinguishingCheck(clues: PressingClues, first: RankedCandidate, second: RankedCandidate): string | null {
        if (clues.runout) {
            const firstRunout = this.getIdentifiers(first.release, "Runout").join(" ");
            const secondRunout = this.getIdentifiers(second.release, "Runout").join(" ");
            if (firstRunout !== secondRunout) {
                return "Compare the runout groove on the record with the Discogs runout data.";
            }
        } 
        if (clues.catno) {
            const firstCatno = (first.release.labels ?? [])
                .map((label) => label.catno ?? "")
                .join(" ");
            const secondCatno = (second.release.labels ?? [])
                .map((label) => label.catno ?? "")
                .join(" ");
            if (firstCatno !== secondCatno) {
                return "Compare the catalog number on the record with the Discogs catalog number data.";
            }
        }   
        
        if (clues.barcode) {
            const firstBarcode = this.getIdentifiers(first.release, "Barcode").join(" ");
            const secondBarcode = this.getIdentifiers(second.release, "Barcode").join(" ");
            if (firstBarcode !== secondBarcode) {
                return "Compare the barcode on the record with the Discogs barcode data.";
            }
        }
 
        if (clues.details) {
            const firstDetails = normalizeText([...toRelease(first.release).formats, first.release.notes ?? ""].join(" "));
            const secondDetails = normalizeText([...toRelease(second.release).formats, second.release.notes ?? ""].join(" "));
            if (firstDetails !== secondDetails) {
                return "Compare the details on the record with the Discogs details data.";
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
        check(
            "runout",
            clues.runout,
            this.getIdentifiers(c.release, "Matrix / Runout"),
            this.weights.runout,
            normalizeCode,
        );

        const descriptions = normalizeText([...r.formats, c.release.notes ?? ""].join(" "));
        if (clues.details !== undefined && descriptions.includes(normalizeText(clues.details ?? ""))) {
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
