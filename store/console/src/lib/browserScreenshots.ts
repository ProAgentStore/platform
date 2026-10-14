/**
 * Browser screenshots (#1064) — the console's half of `workers/api/src/routes/instances-browser-screenshots.ts`.
 * One switch per instance, covering every browser run it makes; the same value MCP's
 * get/set_browser_screenshots read and write.
 */
export interface BrowserScreenshotsView {
	enabled: boolean;
	/** What the switch does, worded by the server so the console, API and MCP say the same thing. */
	explained: string;
}

/** The runtimes whose runs take replay frames: workflow tasks, local research, Application Runner fills. */
const SCREENSHOT_RUNTIMES = new Set(["browser", "local_browser", "local_apply"]);

/** Does this agent run a browser at all — i.e. is there anything for the switch to turn off? */
export function takesBrowserScreenshots(caps: { runtime?: string | null; surfaces?: readonly string[] }): boolean {
	return SCREENSHOT_RUNTIMES.has(caps.runtime ?? "") || !!caps.surfaces?.includes("apply");
}
