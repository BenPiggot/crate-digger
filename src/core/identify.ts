import type { RawVersion, RawRelease } from "./discogs.js";


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

class PressingIdentifier {
    // Implementation for identifying pressings based on clues
    private readonly weights: Record<ClueKind, number>;
    private readonly runoutThreshold: number;

    constructor(options: IdentifyOptions = {}) {
        this.weights = {
            format: 1,
            country: 1,
            year: 1,
            label: 1,
            catno: 1,
            barcode: 1,
            runout: 1,
            details: 1,
            ...options.weights,
        };
        this.runoutThreshold = 0.8; // Example threshold for runout clue
    }

    // will return RankedCandidate when done here
    rank(clues: PressingClues, candidates: Candidate[]): RankedCandidate[] {
        // Implementation for ranking candidates based on clues
        return [];
    }

    distinguishingCheck(candidates: RankedCandidate[]): string | null {
        // Implementation for distinguishing check among ranked candidates
        return null;
    }
}