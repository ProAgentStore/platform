import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright";
import { NativeTabRegistry } from "./native-tab-registry.js";

it("fails closed when concurrent context creation makes native registration order unknowable", () => {
	const all: BrowserContext[] = [];
	const context = () => {
		const pages: Page[] = [];
		const events = new EventEmitter();
		const owner = Object.assign(events, { pages: () => pages, browser: () => ({ contexts: () => all }) }) as unknown as BrowserContext;
		all.push(owner);
		return { owner, add: () => { const page = Object.assign(new EventEmitter(), { isClosed: () => false }) as unknown as Page; pages.push(page); events.emit("page", page); return page; } };
	};
	const main = context(); main.add();
	const registry = new NativeTabRegistry(() => {}, () => {});
	registry.reset(main.owner);
	const before = registry.beforeNew();
	const isolated = context(); isolated.add();
	main.add(); // native registered isolated first; PAGS observed this popup first
	expect(() => registry.finishNew("isolated", before)).toThrow("registration order changed concurrently");
	expect(() => registry.pages()).toThrow("reconnect");
	expect(registry.healthy()).toBe(false);
	registry.reset(main.owner);
	expect(registry.healthy()).toBe(true);
	expect(registry.pages()).toHaveLength(2);
});
