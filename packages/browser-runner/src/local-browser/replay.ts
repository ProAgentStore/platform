/**
 * Replay screenshots of a local browser run (#1063) — Scout research and Application Runner fills.
 *
 * Captured by the RUNNER at points the bridge chooses (after a navigation, an accepted click, a snapshot,
 * a fill, a pause, completion). The application bridge can also return a fresh captured frame to its
 * acting model, through the same frozen screenshot/privacy policy. Recent frames stay in a bounded
 * rolling buffer for the cloud to PULL (the runner holds no API token);
 * old uncollected frames can be evicted, which the pull reports as a cursor-relative gap.
 * the trace only ever says that a frame exists — `screenshot.captured` with its seq and capture point.
 *
 * ── Form-control policy (default masked; owner opt-out #1433)
 *
 * An application page holds the owner's typed answers, and a pixel of a filled field is a typed value.
 * Until #1419 this blurred the TOP document only, by injecting a `<style>` through `browser_evaluate` —
 * nothing iterated frames or pierced shadow roots, so a control inside an `<iframe>` (embedded ATS,
 * payment or identity widgets) or a shadow root was captured in plain pixels while the trace claimed the
 * frame was masked. `page.screenshot`'s own `style` option (a stylesheet applied only for the capture,
 * piercing shadow DOM and inner frames, since Playwright v1.41) plus `mask: Locator[]` with `maskColor`
 * (paints a box over each matched element) replace it: neither mutates the page, so there is nothing to
 * undo, and `style` alone already reaches every frame and shadow root with no need to enumerate them.
 * Only an explicit frozen `blurFormFields: false` omits both layers, capturing normal rendered pixels.
 * Password controls keep the browser's own masking. A throw means NO screenshot: fail closed.
 *
 * Bounded: a per-run cap, viewport only, a per-frame byte cap, and nothing written to disk.
 */
import type { Locator } from "playwright";
import type { ReplayShot, ReplayShotsPage } from "./contract.js";

export type { ReplayShot, ReplayShotsPage } from "./contract.js";
/** Where a frame was taken — the API's `CAPTURE_POINTS` vocabulary. */
export type ReplayPoint = ReplayShot["point"];

/** In-memory rolling capacities. Cloud history is independent of this recent-frame buffer. */
export const SCOUT_SHOT_CAP = 60;
export const APPLY_SHOT_CAP = 40;
/** One frame, as base64 characters (~768 KiB of JPEG) — the API refuses larger, so the runner never sends one. */
export const MAX_SHOT_BASE64 = Math.ceil((768 * 1024 * 4) / 3);
/** One pull's reply stays well under the relay's message limit. At least one frame is always returned. */
export const SHOTS_PAGE_BASE64 = 900 * 1024;

/** Applied only for the instant of the capture — pierces Shadow DOM and inner frames natively (#1419). */
export const MASK_CSS = "input, textarea, select, option, [contenteditable], [contenteditable] * { filter: blur(8px) !important; }";
/** Elements `mask` paints over directly, as defence in depth on top of `MASK_CSS` for the top document. */
export const MASK_SELECTOR = "input, textarea, select, [contenteditable]";
export const MASK_COLOR = "#0b0b0b";

/** The minimum of Playwright's real `Page` a masked screenshot needs — real in production, faked in tests. */
export interface MaskablePage {
	url?(): string;
	locator(selector: string): Locator;
	screenshot(opts: { type: "jpeg"; quality: number; scale: "css"; style?: string; mask?: Locator[]; maskColor?: string; timeout: number }): Promise<Buffer>;
}

/**
 * The form-control policy for a Playwright `Page` (#1067, Playwright-native since #1419) — the legacy
 * workflow browser tasks (`runtime_task`: JOB_APPLY / BROWSER_TASK) and the stored takeover still frame,
 * and `ShotRecorder.capture` below for Scout/Application Runner replay. One call: no mask confirmation
 * step exists any more because nothing mutates the page for Playwright to confirm. NO frame (undefined)
 * on any failure — a timeout, a closed page — exactly as before. Only literal false opts out of masking.
 */
export async function capturePageScreenshot(page: MaskablePage, opts: { quality: number; timeout: number; blurFormFields?: unknown }): Promise<string | undefined> {
	try {
		const buf = await page.screenshot({
			type: "jpeg",
			quality: opts.quality,
			scale: "css",
			...(opts.blurFormFields === false ? {} : {
				style: MASK_CSS,
				mask: [page.locator(MASK_SELECTOR)],
				maskColor: MASK_COLOR,
			}),
			timeout: opts.timeout,
		});
		return buf.toString("base64");
	} catch {
		return undefined;
	}
}

/** Compatibility entry point: callers without an owner policy always mask. */
export function maskedPageScreenshot(page: MaskablePage, opts: { quality: number; timeout: number }): Promise<string | undefined> {
	return capturePageScreenshot(page, opts);
}

export class ShotRecorder {
	readonly shots: ReplayShot[] = [];
	private nextSeq = 0;

	constructor(
		private readonly cap: number,
		private readonly now: () => number = Date.now,
		private readonly blurFormFields: unknown = true,
	) {}

	get enabled(): boolean { return this.cap > 0; }
	get formFieldsBlurred(): boolean { return this.blurFormFields !== false; }

	/**
	 * Take one frame, best-effort. Returns its seq, or null when capture is disabled, this
	 * run has no real page to capture (#1419 — a browser the runner did not itself launch), or the
	 * masked screenshot failed.
	 */
	async capture(page: MaskablePage | null, point: ReplayPoint, meta: { url?: string; action?: string; target?: string } = {}): Promise<number | null> {
		return (await this.captureResult(page, point, meta)).seq;
	}

	/** The reason is explicit so a replay can distinguish missing evidence from an unchanged page. */
	async captureResult(page: MaskablePage | null, point: ReplayPoint, meta: { url?: string; action?: string; target?: string } = {}, accept?: () => boolean): Promise<{ seq: number } | { seq: null; reason: "capture_limit" | "page_unavailable" | "capture_failed" | "frame_too_large" | "capture_invalidated" }> {
		if (this.cap <= 0 || this.nextSeq >= Number.MAX_SAFE_INTEGER) return { seq: null, reason: "capture_limit" };
		if (!page) return { seq: null, reason: "page_unavailable" };
		const data = await capturePageScreenshot(page, { quality: 50, timeout: 8_000, blurFormFields: this.blurFormFields });
		if (!data) return { seq: null, reason: "capture_failed" };
		if (data.length > MAX_SHOT_BASE64) return { seq: null, reason: "frame_too_large" };
		// Revalidate ownership/Stop after the asynchronous capture, before retaining pixels or assigning a sequence.
		try { if (accept && !accept()) return { seq: null, reason: "capture_invalidated" }; }
		catch { return { seq: null, reason: "capture_invalidated" }; }
		const seq = ++this.nextSeq;
		this.shots.push({ seq, point, ...(meta.url ? { url: meta.url } : {}), ...(meta.action ? { action: meta.action } : {}), ...(meta.target ? { target: meta.target } : {}), mimeType: "image/jpeg", data, at: new Date(this.now()).toISOString() });
		if (this.shots.length > this.cap) this.shots.splice(0, this.shots.length - this.cap);
		return { seq };
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
		const lastSeq = out.length ? out[out.length - 1].seq : afterSeq;
		const oldestSeq = this.shots[0]?.seq ?? null;
		return { runId, shots: out, lastSeq, hasMore: this.shots.some((shot) => shot.seq > lastSeq), coverage: {
			mode: "rolling", capacity: this.cap, oldestSeq, latestSeq: this.nextSeq, evicted: Math.max(0, this.nextSeq - this.shots.length),
			...(oldestSeq !== null && afterSeq < oldestSeq - 1 ? { gap: { fromSeq: Math.max(1, afterSeq + 1), toSeq: oldestSeq - 1 } } : {}),
		} };
	}
}
