/** Bounded metadata paging for long screenshot timelines; never a current-screen claim. */
import type { BrowserArtifactListResponse, BrowserArtifactView, ReplaySubjectKind } from "./runReplay";

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
	hasMore?: boolean;
	nextCursor?: string | null;
	coverage?: BrowserArtifactCoverage;
}
export interface ReplayHistoryState {
	artifacts: BrowserArtifactView[];
	screenshotsOff: boolean;
	coverage?: BrowserArtifactCoverage;
	/** Contiguous API pagination progress; latest-tail reads never advance it. */
	cursor: number;
	hasMore: boolean;
	status: "loading" | "complete" | "partial" | "unavailable";
	message: string;
	error: string | null;
}
export const emptyReplayHistory = (): ReplayHistoryState => ({ artifacts: [], screenshotsOff: false, cursor: -1, hasMore: true, status: "loading", message: "Loading stored screenshot history…", error: null });
export const REPLAY_PAGE_SIZE = 100;
export const REPLAY_HISTORY_PAGES = 10;
export type ReadReplayPage = (after: number, limit: number) => Promise<BrowserArtifactPageResponse>;

type Subject = { kind: ReplaySubjectKind; id: string };
function checkedPage(page: BrowserArtifactPageResponse, subject: Subject, after: number): BrowserArtifactPageResponse {
	if (!page || !Array.isArray(page.artifacts) || (page.subjectId !== undefined && page.subjectId !== subject.id) || (page.subjectKind !== undefined && page.subjectKind !== subject.kind)) throw new Error("Screenshot response belongs to another run or is invalid.");
	if (page.artifacts.length > REPLAY_PAGE_SIZE) throw new Error("Screenshot server did not honor the requested page limit.");
	let seq = after;
	for (const frame of page.artifacts) {
		if (!frame || typeof frame.id !== "string" || !Number.isSafeInteger(frame.seq) || frame.seq <= seq || frame.subjectKind !== subject.kind || frame.subjectId !== subject.id) throw new Error("Screenshot page has invalid or unordered frame identities.");
		seq = frame.seq;
	}
	if (page.hasMore === false && page.nextCursor !== null && page.nextCursor !== undefined) throw new Error("Screenshot page has conflicting continuation metadata.");
	if (page.hasMore === true && (!page.artifacts.length || page.nextCursor !== String(seq))) throw new Error("Screenshot continuation did not advance safely.");
	return page;
}

/** At most ten history pages plus one newest-tail page per call. Failed/incomplete reads retain
 * earlier evidence and their continuation, so retry cannot skip an unread history page. */
export async function loadReplayHistory(previous: ReplayHistoryState, subject: Subject, read: ReadReplayPage): Promise<ReplayHistoryState> {
	const frames = new Map(previous.artifacts.map((frame) => [frame.id, frame]));
	const next: ReplayHistoryState = { ...previous, status: "partial", message: "History pagination is incomplete.", error: null };
	let failure = "";
	let legacy = false;
	const retain = (page: BrowserArtifactPageResponse) => {
		for (const frame of page.artifacts) frames.set(frame.id, frame);
		next.screenshotsOff = page.screenshotsOff === true;
		if (page.coverage) next.coverage = page.coverage;
	};
	try {
		for (let index = 0; index < REPLAY_HISTORY_PAGES; index++) {
			const page = checkedPage(await read(next.cursor, REPLAY_PAGE_SIZE), subject, next.cursor);
			retain(page);
			if (page.hasMore === undefined) {
				legacy = true;
				next.hasMore = false;
				next.message = "The server did not provide screenshot pagination. Returned frames are shown; complete history is unverified.";
				break;
			}
			if (page.artifacts.length) next.cursor = page.artifacts[page.artifacts.length - 1].seq;
			next.hasMore = page.hasMore;
			if (!page.hasMore) { next.status = "complete"; next.message = "All currently listed stored screenshots are loaded. This is not a live browser screen."; break; }
		}
	} catch (error) { failure = error instanceof Error ? error.message : "Screenshot history could not be refreshed."; }
	// Make the latest stored frame reachable even while a large older backlog is loading.
	// This tail is independent of the primary cursor: missing middle pages remain loadable.
	const latest = next.coverage?.lastStoredSeq;
	if (!legacy && latest !== null && latest !== undefined && latest > next.cursor) {
		next.hasMore = true;
		next.status = "partial";
		next.message = "History pagination is incomplete. The newest available frames are included when possible.";
	}
	if (!legacy && latest !== null && latest !== undefined && latest > next.cursor && !Array.from(frames.values()).some((frame) => frame.seq === latest)) {
		try { retain(checkedPage(await read(Math.max(-1, latest - REPLAY_PAGE_SIZE), REPLAY_PAGE_SIZE), subject, Math.max(-1, latest - REPLAY_PAGE_SIZE))); }
		catch (error) { failure ||= error instanceof Error ? error.message : "The latest stored screenshot could not be loaded."; }
	}
	next.artifacts = [...frames.values()].sort((a, b) => a.seq - b.seq);
	if (failure) { next.error = failure; next.status = frames.size ? "partial" : "unavailable"; next.message = `Screenshot history is incomplete: ${failure} Previously loaded frames are retained.`; }
	return next;
}

export function replayHistorySummary(state: ReplayHistoryState): string {
	const total = state.coverage?.storedFrames;
	const loaded = total === undefined ? `${state.artifacts.length} stored frames loaded.` : `${state.artifacts.length} frames loaded; ${total} stored frames reported.`;
	const gaps = state.coverage?.basis === "stored_local_capture_sequences" ? state.coverage.missingRanges.length : 0;
	return `${loaded} ${state.message}${gaps ? ` ${gaps}${state.coverage?.rangesTruncated ? "+" : ""} gap${gaps === 1 ? "" : "s"} in stored capture sequences. Missing frames may reflect buffer eviction, rejected captures, or expired retention.` : ""}`;
}
