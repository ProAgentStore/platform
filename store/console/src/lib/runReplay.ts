/**
 * Screenshot replay for every browser run (#1063) — what the console needs to know, kept pure.
 *
 * The shapes are the Worker's (`agent-types.ts` `BrowserArtifactView` / `BrowserArtifactListResponse`),
 * held against it in `types.test.ts`. A run's frames come from ONE list: its stored artifacts, by subject
 * (`runtime_task`, `local_browser_run`, `local_apply_run`). The only other source is a legacy workflow
 * task's older `agent.shot` events with no artifact id — screenshots taken before the contract, still
 * served from their original route.
 */
export type ReplaySubjectKind = "runtime_task" | "local_browser_run" | "local_apply_run";

export interface BrowserArtifactView {
	id: string;
	subjectKind: ReplaySubjectKind;
	subjectId: string;
	seq: number;
	contentType: string;
	bytes: number;
	point: string;
	url: string | null;
	domain: string | null;
	action: string | null;
	createdAt: string;
}

export interface BrowserArtifactListResponse {
	subjectKind: ReplaySubjectKind;
	subjectId: string;
	artifacts: BrowserArtifactView[];
	/** The run started with the owner's screenshot switch OFF (#1064): no frames by design. */
	screenshotsOff: boolean;
}

/** The replay's empty state for a run started with the owner's screenshot switch OFF (#1064) — on purpose, not missing. */
export const SCREENSHOTS_OFF_TEXT = "Screenshots were off for this run — the agent's Browser screenshots setting was off when it started, so no frames were taken or stored. Turn it on in Settings for future runs.";

/** One frame the player shows. `src` is an API path, fetched with the owner's token. */
export interface ReplayFrame {
	key: string;
	seq: number;
	caption: string;
	at?: string;
	src: string;
}

/** A legacy `agent.shot` event, as RunDetail reads it off the task's activity. */
export interface LegacyShot {
	seq: number;
	artifactId?: string;
	msg: string;
	at?: string;
}

const POINT_WORDS: Record<string, string> = {
	navigated: "Opened a page",
	clicked: "Clicked",
	snapshot: "Read the page",
	waited: "Waited for the page",
	paused: "Paused for you",
	blocked: "Stopped at a blocker",
	filled: "Filled a field",
	uploaded: "Attached a document",
	checkpoint: "Checkpoint",
	review: "Ready for review",
	submit: "Submitted",
	completed: "Finished",
	action: "Acted on the page",
};

/** A frame's caption from its stored metadata: what happened, and where. Never page text. */
export function artifactCaption(a: Pick<BrowserArtifactView, "point" | "domain" | "action">): string {
	const what = POINT_WORDS[a.point] ?? "Acted on the page";
	return a.domain ? `${what} — ${a.domain}` : what;
}

export const artifactSrc = (instanceId: string, artifactId: string) => `/v1/instances/${instanceId}/browser-artifacts/${encodeURIComponent(artifactId)}`;
export const legacyShotSrc = (instanceId: string, taskId: string, seq: number) => `/v1/instances/${instanceId}/tasks/${taskId}/shots/${seq}`;

/**
 * The frames to play, in order. Stored artifacts first-class (a legacy task's own event message, when it
 * has one for that seq, is the better caption); then any older `agent.shot` with no artifact id, from the
 * legacy route — so a run recorded before the contract still plays.
 */
export function replayFrames(instanceId: string, artifacts: readonly BrowserArtifactView[], legacy: { taskId: string; shots: readonly LegacyShot[] } | null = null): ReplayFrame[] {
	const messages = new Map((legacy?.shots ?? []).map((s) => [s.seq, s.msg]));
	const stored = new Set(artifacts.map((a) => a.seq));
	const frames: ReplayFrame[] = artifacts.map((a) => ({ key: `a:${a.id}`, seq: a.seq, caption: messages.get(a.seq) || artifactCaption(a), at: a.createdAt, src: artifactSrc(instanceId, a.id) }));
	if (legacy) {
		for (const s of legacy.shots) {
			if (s.artifactId || stored.has(s.seq)) continue;
			frames.push({ key: `l:${s.seq}`, seq: s.seq, caption: s.msg, at: s.at, src: legacyShotSrc(instanceId, legacy.taskId, s.seq) });
		}
	}
	return frames.sort((a, b) => a.seq - b.seq);
}
