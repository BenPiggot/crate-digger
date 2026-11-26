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

type ClueKind = "format" | "country" | "year" | "label" | "catno" | "barcode" | "runout" | "details";

export interface IdentifyOptions   {
    weights?: Partial<Record<ClueKind, number>>;
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

    constructor(options: IdentifyOptions = {}) {
        this.weights = {
            format: 1,
            country: 2,
            year: 1,
            label: 1,
            catno: 3,
            barcode: 5,
            runout: 5,
            details: 1,
            ...options.weights,
        };
        this.runoutThreshold = 0.8; // Example threshold for runout clue
    }

    // will return RankedCandidate when done here
    rank(clues: PressingClues, candidates: Candidate[]): RankedCandidate[] {
        return candidates
            .map((candidate) => this.score(clues, candidate))
            .sort((a, b) => b.score - a.score);
  
 
    }

    // distinguishingCheck(candidates: RankedCandidate[]): string | null {
    //     // Implementation for distinguishing check among ranked candidates
    //     return null;
    // }

    private score(clues: PressingClues, c: Candidate): RankedCandidate {
        const result = { ...c, score: 0, matched: [] as string[], conflicts: [] as string[] };
        const r = toRelease(c.release);

        const check = (name: string, clue: string | undefined, values: string[], 
            weight: number, norm: (s: string) => string) => {
            if (clue === undefined || values.length === 0) return;  // no clue, or Discogs has no data
            if (values.map(norm).includes(norm(clue))) {
                result.score += weight;
                result.matched.push(`${name} '${clue}' matches`);
            } else {
                result.score -= weight;
                result.conflicts.push(`${name} '${clue}' doesn't match`);
            }
        };

        check('catno', clues.catno, (c.release.labels ?? []).map((label) => label.catno ?? ""), this.weights.catno, normalizeCode);
        check('barcode', clues.barcode, this.getIdentifiers(c.release, "Barcode"), this.weights.barcode, digitsOnly);
        for (const runout of clues.runout ?? []) {
            check('runout', runout, this.getIdentifiers(c.release, "Runout"), this.weights.runout, normalizeCode);
        }

        const descriptions = r.format_description === null ? "" : normalizeText(r.format_description);
        for (const detail of clues.details ?? []) {
            if (descriptions.includes(normalizeText(detail))) {
                result.score += this.weights.details;
                result.matched.push(`'${detail}' appears in format description`);
            }
        }

        return result;
    }

    private getIdentifiers(release: RawRelease, type: string = "Barcode"){
        return (release.identifiers ?? [])
            .filter((i) => i.type === type)
            .map((i) => (i.value ?? "").replace(/\D/g, ""))
            .filter(Boolean);
    }

}
