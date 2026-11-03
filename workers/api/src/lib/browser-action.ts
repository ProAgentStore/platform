/** One action the runner performs on the live page (mirrors the runner's BrowserAction). */
export interface BrowserAction {
	action: "click" | "type" | "select" | "check" | "upload" | "navigate" | "scroll" | "key" | "wait";
	/** Stable element ref from the snapshot (e.g. "e42") — unambiguous targeting. */
	ref?: string;
	role?: string;
	name?: string;
	nth?: number;
	text?: string;
	file?: string;
	url?: string;
	key?: string;
	dy?: number;
	ms?: number;
}
