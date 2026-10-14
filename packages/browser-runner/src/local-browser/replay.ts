/**
 * Replay screenshots of a local browser run (#1063) — Scout research and Application Runner fills.
 *
 * Captured by the RUNNER at points the bridge chooses (after a navigation, an accepted click, a snapshot,
 * a fill, a pause, completion), never by the model: `browser_take_screenshot` stays refused to the CLI, so
 * a screenshot is evidence the platform keeps, not a tool that could read a page around the redacted
 * trace. Frames stay in this process's memory until the cloud PULLS them (the runner holds no API token);
 * the trace only ever says that a frame exists — `screenshot.captured` with its seq and capture point.
 *
 * ── Form-control policy (decided on #1063)
 *
 * An application page holds the owner's typed answers, and a pixel of a filled field is a typed value.
 * So before every capture the recorder BLURS every form control on the page — inputs, textareas, selects
 * and contenteditable regions — and removes the blur straight after. If the blur cannot be confirmed in
 * place, NO screenshot is taken: fail closed. The same policy runs on Scout pages, where it costs nothing.
 *
 * Bounded: a per-run cap, viewport only, a per-frame byte cap, and nothing written to disk.
 */
import type { BrowserTools } from "./bridge.js";
import type { ReplayShot, ReplayShotsPage } from "./contract.js";
import { evaluateResult } from "./bridge.js";

export type { ReplayShot, ReplayShotsPage } from "./contract.js";
/** Where a frame was taken — the API's `CAPTURE_POINTS` vocabulary. */
export type ReplayPoint = ReplayShot["point"];

/** Per-run caps (#1063): enough to replay a run, not enough to make storage unbounded. */
export const SCOUT_SHOT_CAP = 60;
export const APPLY_SHOT_CAP = 40;
/** One frame, as base64 characters (~768 KiB of JPEG) — the API refuses larger, so the runner never sends one. */
export const MAX_SHOT_BASE64 = Math.ceil((768 * 1024 * 4) / 3);
/** One pull's reply stays well under the relay's message limit. At least one frame is always returned. */
export const SHOTS_PAGE_BASE64 = 900 * 1024;

const MASK_ID = "__pags_replay_mask";
/** Runs in the page through the browser's own evaluate — never offered to the CLI. */
export const MASK_FORM_CONTROLS = `() => {
	let s = document.getElementById(${JSON.stringify(MASK_ID)});
	if (!s) {
		s = document.createElement("style");
		s.id = ${JSON.stringify(MASK_ID)};
		s.textContent = "input, textarea, select, option, [contenteditable], [contenteditable] * { filter: blur(8px) !important; }";
		(document.head || document.documentElement).appendChild(s);
	}
	return document.getElementById(${JSON.stringify(MASK_ID)}) ? "masked" : "unmasked";
}`;
export const UNMASK_FORM_CONTROLS = `() => { const s = document.getElementById(${JSON.stringify(MASK_ID)}); if (s) s.remove(); return "unmasked"; }`;

const textOf = (r: { content?: Array<{ text?: string }> }) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

export class ShotRecorder {
	readonly shots: ReplayShot[] = [];
	private nextSeq = 0;

	constructor(
		private readonly cap: number,
		private readonly now: () => number = Date.now,
	) {}

	/**
	 * Take one frame, best-effort. Returns its seq, or null when none was kept: the cap is reached, the
	 * form controls could not be masked (fail closed), or the browser gave no image.
	 */
	async capture(browser: BrowserTools, point: ReplayPoint, meta: { url?: string; action?: string } = {}): Promise<number | null> {
		if (this.nextSeq >= this.cap) return null;
		try {
			const masked = await browser.callTool("browser_evaluate", { function: MASK_FORM_CONTROLS });
			if (masked.isError || evaluateResult(textOf(masked)) !== "masked") return null;
			try {
				const res = await browser.callTool("browser_take_screenshot", { type: "jpeg" });
				const image = res.isError ? undefined : (res.content ?? []).find((c) => c.type === "image" && typeof c.data === "string" && c.data.length > 0);
				if (!image?.data || image.data.length > MAX_SHOT_BASE64) return null;
				const seq = ++this.nextSeq;
				this.shots.push({ seq, point, ...(meta.url ? { url: meta.url } : {}), ...(meta.action ? { action: meta.action } : {}), mimeType: image.mimeType ?? "image/jpeg", data: image.data, at: new Date(this.now()).toISOString() });
				return seq;
			} finally {
				await browser.callTool("browser_evaluate", { function: UNMASK_FORM_CONTROLS }).catch(() => undefined);
			}
		} catch {
			return null;
		}
	}

	/** The frames after `afterSeq`, paged by size; `lastSeq` never runs past a frame not returned. */
	page(runId: string, afterSeq: number): ReplayShotsPage {
		const out: ReplayShot[] = [];
		let size = 0;
		for (const s of this.shots) {
			if (s.seq <= afterSeq) continue;
			if (out.length && size + s.data.length > SHOTS_PAGE_BASE64) break;
			out.push(s);
			size += s.data.length;
		}
		return { runId, shots: out, lastSeq: out.length ? out[out.length - 1].seq : afterSeq };
	}
}
