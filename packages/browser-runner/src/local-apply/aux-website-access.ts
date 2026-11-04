/** Website policy at direct Page/takeover boundaries, which do not pass through MCP calls. */
import type { Page, Route } from "playwright";
import { type BrowserWebsiteAccess, type WebsiteAccessBlock, websiteAccessBlock } from "../browser-website-access.js";
import { RunnerInputError } from "../errors.js";
import type { RunBrowser } from "./runtime.js";

export class AuxiliaryWebsiteAccess {
	blocked?: WebsiteAccessBlock;
	private dispose?: () => Promise<void>;
	constructor(readonly policy?: BrowserWebsiteAccess) {}
	check(url: string, actionDispatched = false): WebsiteAccessBlock | undefined {
		if (this.blocked) return this.blocked;
		if (!this.policy || url === "about:blank") return undefined;
		const parsed = new URL(url);
		if (!["https:", "http:"].includes(parsed.protocol)) throw new RunnerInputError("Only HTTP(S) websites are available in this session", 403);
		this.blocked = websiteAccessBlock(this.policy, url, actionDispatched) ?? undefined;
		return this.blocked;
	}
	async install(browser: RunBrowser, page: Page): Promise<void> {
		browser.tools?.setCallPolicy?.({ guard: { mode: "read_only" }, websiteAccess: () => this.policy });
		if (!this.policy) return;
		const context = page.context();
		const intercept = async (route: Route) => {
			const request = route.request();
			if (!request.isNavigationRequest()) return route.fallback();
			let target = request.frame().page();
			// A new popup's first request also belongs to this bounded session; other tabs do not.
			while (target !== page) {
				const opener = await target.opener();
				if (!opener) return route.fallback();
				target = opener;
			}
			try { if (this.check(request.url(), true)) return route.abort("blockedbyclient"); }
			catch { return route.abort("blockedbyclient"); }
			return route.fallback();
		};
		await context.route("**/*", intercept);
		this.dispose = () => context.unroute("**/*", intercept);
	}
	async close(): Promise<void> { await this.dispose?.().catch(() => undefined); this.dispose = undefined; }
}
