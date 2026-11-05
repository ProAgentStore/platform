import type { Page } from "playwright";

const UNAVAILABLE = "[title unavailable: native metadata read exceeded its budget]";
type TitleRead = { started: number; budget: number; promise: Promise<string> };
type Tracked = { id: number; title: Page["title"]; bringToFront: Page["bringToFront"]; closed: () => void; read?: TitleRead; foreground?: number };

/** Optional tab titles must not hold a completed native action behind an unresponsive renderer.
 * Reads get at most 5s and a quarter of the configured command budget. A timed-out read is
 * coalesced until it actually settles; foreground actions are observed, never cancelled/replayed.
 */
export class NativeTabMetadata {
	private readonly pages = new Map<Page, Tracked>();
	private sequence = 0;
	constructor(private readonly commandBudgetMs: () => number) {}
	track(page: Page): void {
		if (this.pages.has(page)) return;
		const state: Tracked = { id: ++this.sequence, title: page.title, bringToFront: page.bringToFront, closed: () => this.restore(page) };
		this.pages.set(page, state);
		page.title = async () => {
			if (!state.read) {
				const read: TitleRead = { started: Date.now(), budget: Math.max(1, Math.min(5_000, Math.floor(this.commandBudgetMs() / 4))), promise: Promise.resolve().then(() => state.title.call(page)) };
				state.read = read;
				// Observe both outcomes even after a metadata deadline; do not dispatch another read.
				void read.promise.then(() => { if (state.read === read) state.read = undefined; }, () => { if (state.read === read) state.read = undefined; });
			}
			const read = state.read;
			const remaining = read.budget - (Date.now() - read.started);
			if (remaining <= 0) return UNAVAILABLE;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try { return await Promise.race([read.promise, new Promise<string>(resolve => { timer = setTimeout(() => resolve(UNAVAILABLE), remaining); })]); }
			finally { if (timer) clearTimeout(timer); }
		};
		page.bringToFront = async () => {
			state.foreground = Date.now();
			try { await state.bringToFront.call(page); }
			finally { state.foreground = undefined; }
		};
		page.once("close", state.closed);
	}
	/** Page identities and phases only: no titles, URLs or page-provided text in diagnostics. */
	pending(): string {
		return [...this.pages.values()].flatMap(state => [
			...(state.foreground !== undefined ? [`page ${state.id}: bringToFront pending ${Date.now() - state.foreground}ms`] : []),
			...(state.read ? [`page ${state.id}: title metadata pending ${Date.now() - state.read.started}ms (budget ${state.read.budget}ms)`] : []),
		]).slice(0, 8).join("; ");
	}
	private restore(page: Page): void {
		const state = this.pages.get(page);
		if (!state) return;
		page.title = state.title; page.bringToFront = state.bringToFront;
		page.off("close", state.closed);
		this.pages.delete(page);
	}
	stop(): void { for (const page of this.pages.keys()) this.restore(page); }
}
