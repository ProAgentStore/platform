import type { BrowserTools } from "../local-browser/bridge.js";

/**
 * The tab a click OPENED (#1133).
 *
 * SEEK's "Apply" can open its sign-in in a NEW tab. Playwright MCP adds a popup to its tab list but keeps
 * the current tab where it was (`_onPageCreated` sets `_currentTab` only when there is none), and the CLI
 * may not switch tabs (`browser_tabs` is refused to it). So every page check after that click — landing,
 * checkpoint, ready_for_review, all of #1100's sign-in detection — read the job ad the click started on,
 * saw no sign-in, and the run ended `review.ready` count 0 (f63b2963, on runner 0.4.145, after #1100).
 *
 * The bridge therefore counts tabs around a page-changing click and selects one that appeared DURING it,
 * so its checks read the page the click led to. Only a new tab: the profile is the owner's real browser,
 * and a tab already open is theirs.
 */
export async function tabCount(browser: BrowserTools): Promise<number | null> {
	const res = await browser.callTool("browser_tabs", { action: "list" }).catch(() => null);
	if (!res || res.isError) return null;
	const body = (res.content ?? []).map((c) => c.text ?? "").join("\n");
	// Only the `### Result` section: Playwright MCP may repeat the same list under `### Open tabs`.
	const result = /### Result\n([\s\S]*?)(?=\n### |$)/.exec(body)?.[1] ?? body;
	return (result.match(/^- \d+:/gm) ?? []).length;
}

/** Select the newest tab when the count grew across a click; true when the run now works in it. */
export async function followOpenedTab(browser: BrowserTools, before: number | null): Promise<boolean> {
	if (before === null) return false;
	const after = await tabCount(browser);
	if (after === null || after <= before) return false;
	const selected = await browser.callTool("browser_tabs", { action: "select", index: after - 1 }).catch(() => null);
	return !!selected && !selected.isError;
}
