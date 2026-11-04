import type { BrowserContext, Page } from "playwright";

/** Mirrors native MCP registration order using Page identities, never URL/name matching. */
export class NativeTabRegistry {
	private ordered: Page[] = [];
	private readonly contexts = new Map<string, BrowserContext>();
	private readonly listeners = new Map<BrowserContext, { page: (page: Page) => void; close: () => void }>();
	private readonly closedPages = new Map<Page, () => void>();
	private invalid?: string;
	constructor(private readonly onIsolatedPage: (page: Page) => void, private readonly onPageClosed: (page: Page, replacement?: Page) => void) {}
	reset(context?: BrowserContext): void {
		for (const [owner, listener] of this.listeners) { owner.off("page", listener.page); owner.off("close", listener.close); }
		for (const [page, listener] of this.closedPages) page.off("close", listener);
		this.closedPages.clear(); this.listeners.clear(); this.contexts.clear(); this.ordered = []; this.invalid = undefined;
		if (context) this.add("default", context);
	}
	/** Only contexts created by this native adapter; the injected default remains caller-owned. */
	async closeIsolated(): Promise<void> {
		await Promise.all([...this.contexts].filter(([name]) => name !== "default").map(([, context]) => context.close()));
	}
	healthy(): boolean { return !this.invalid; }
	pages(): Page[] {
		if (this.invalid) throw new Error(this.invalid);
		return this.ordered.filter(page => !page.isClosed());
	}
	private refuse(message: string): never { this.invalid = message; throw new Error(message); }
	private addPage(page: Page): void {
		if (this.ordered.includes(page)) return;
		this.ordered.push(page);
		const closed = () => {
			const index = this.ordered.slice(0, this.ordered.indexOf(page)).filter(candidate => !candidate.isClosed()).length;
			const pages = this.ordered.filter(candidate => !candidate.isClosed());
			this.onPageClosed(page, pages[Math.min(index, pages.length - 1)]);
		};
		this.closedPages.set(page, closed);
		page.once("close", closed);
	}
	private add(name: string, context: BrowserContext): void {
		this.contexts.set(name, context);
		for (const page of context.pages()) this.addPage(page);
		const listener = (page: Page) => {
			this.addPage(page);
			if (name !== "default") this.onIsolatedPage(page);
		};
		const close = () => { if (this.contexts.get(name) === context) this.contexts.delete(name); };
		this.listeners.set(context, { page: listener, close });
		context.on("page", listener);
		context.once("close", close);
	}
	/** Called only around native browser_tabs(new), while the task owns this browser. */
	beforeNew(): { contexts: BrowserContext[]; pages: Page[] } {
		return { contexts: [...(this.contexts.get("default")?.browser()?.contexts() ?? [])], pages: this.pages() };
	}
	finishNew(name: unknown, before: ReturnType<NativeTabRegistry["beforeNew"]>): Page | undefined {
		const key = typeof name === "string" && name ? name : "default";
		let context = this.contexts.get(key);
		if (!context) {
			const added = (this.contexts.get("default")?.browser()?.contexts() ?? []).filter(candidate => !before.contexts.includes(candidate));
			if (!added.length) return undefined;
			if (added.length !== 1) this.refuse("Native isolated-context ownership is ambiguous; reconnect the run before further actions.");
			if (this.pages().some(page => !before.pages.includes(page))) this.refuse("Native tab registration order changed concurrently; reconnect the run before further actions.");
			context = added[0];
			this.add(key, context);
		}
		const created = context.pages().filter(page => !before.pages.includes(page));
		if (!created.length) return undefined;
		if (created.length !== 1) this.refuse("Native new-tab identity is ambiguous; reconnect the run before further actions.");
		return created[0];
	}
}
