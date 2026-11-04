/** Wire-only screenshot contracts. No Worker bindings or service implementations. */
import type { BrowserArtifactListResponse } from "../agent-types.js";

export interface BrowserArtifactCoverage {
	basis: "stored_local_capture_sequences" | "stored_workflow_steps";
	storedFrames: number;
	firstStoredSeq: number | null;
	lastStoredSeq: number | null;
	missingRanges: Array<{ fromSeq: number; toSeq: number }>;
	rangesTruncated: boolean;
	notice: string;
}

export interface BrowserArtifactPageResponse extends BrowserArtifactListResponse {
	hasMore: boolean;
	nextCursor: string | null;
	coverage: BrowserArtifactCoverage;
}
