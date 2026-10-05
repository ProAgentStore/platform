/**
 * The service worker's push + click handlers, run for real against a fake worker scope (#897).
 *
 * `store/sw.js` is a static file the browser loads as-is, so it cannot import the console's route
 * helpers — which is how its click path drifted from `notificationRoute`: on
 * console.proagentstore.online (app mounted at `/`) every tap navigated to a `/console/…` path the
 * router does not have and landed on the home screen. These run the file itself, on both hosts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(__dirname, "../../../sw.js"), "utf8");

interface FakeClient {
	url: string;
	visibilityState: "visible" | "hidden";
	navigated: string[];
	focused: boolean;
	messages: unknown[];
	navigate(u: string): Promise<FakeClient>;
	focus(): Promise<FakeClient>;
	postMessage(m: unknown): void;
}

function client(url: string, visibilityState: "visible" | "hidden" = "hidden"): FakeClient {
	const c: FakeClient = {
		url,
		visibilityState,
		navigated: [],
		focused: false,
		messages: [],
		async navigate(u) {
			c.navigated.push(u);
			return c;
		},
		async focus() {
			c.focused = true;
			return c;
		},
		postMessage(m) {
			c.messages.push(m);
		},
	};
	return c;
}

/** Load sw.js into a fresh scope on `origin`, with these tabs open. */
function worker(origin: string, tabs: FakeClient[] = []) {
	const listeners: Record<string, (e: unknown) => void> = {};
	const shown: Array<{ title: string; options: { tag: string; data: { url: string } } }> = [];
	const opened: string[] = [];
	const self = {
		location: new URL(origin),
		addEventListener: (type: string, fn: (e: unknown) => void) => {
			listeners[type] = fn;
		},
		skipWaiting: () => undefined,
		clients: {
			claim: async () => undefined,
			matchAll: async () => tabs,
			openWindow: async (u: string) => {
				opened.push(u);
				return null;
			},
		},
		registration: {
			showNotification: async (title: string, options: { tag: string; data: { url: string } }) => {
				shown.push({ title, options });
			},
		},
	};
	new Function("self", SOURCE)(self);

	const run = async (type: string, event: Record<string, unknown>) => {
		let pending: Promise<unknown> = Promise.resolve();
		listeners[type]?.({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
		await pending;
	};
	return {
		shown,
		opened,
		push: (payload: Record<string, unknown>) => run("push", { data: { json: () => payload, text: () => JSON.stringify(payload) } }),
		click: (url?: string) => run("notificationclick", { notification: { close: () => undefined, data: url === undefined ? {} : { url } } }),
	};
}

const APEX = "https://proagentstore.online";
const CONSOLE = "https://console.proagentstore.online";
const LINK = "/console/instances/i1/coding/s1";

describe("a notification click opens its subject on both hosts (#897)", () => {
	it("on proagentstore.online, cold: opens the producer's /console path as-is", async () => {
		const sw = worker(APEX);
		await sw.click(LINK);
		expect(sw.opened).toEqual([LINK]);
	});

	it("on console.proagentstore.online, cold: drops the /console prefix the router there does not have", async () => {
		const sw = worker(CONSOLE);
		await sw.click(LINK);
		expect(sw.opened).toEqual(["/instances/i1/coding/s1"]);
	});

	it("keeps the query a deploy link carries", async () => {
		const sw = worker(CONSOLE);
		await sw.click("/console/instances/i1/coding?builds=r1");
		expect(sw.opened).toEqual(["/instances/i1/coding?builds=r1"]);
	});

	it("moves an open console tab rather than opening another — on either host", async () => {
		for (const [origin, tabUrl, expected] of [
			[APEX, `${APEX}/console/usage`, LINK],
			[CONSOLE, `${CONSOLE}/usage`, "/instances/i1/coding/s1"],
		] as const) {
			const tab = client(tabUrl);
			const sw = worker(origin, [tab]);
			await sw.click(LINK);
			expect(tab.navigated).toEqual([expected]);
			expect(tab.focused).toBe(true);
			expect(sw.opened).toEqual([]);
		}
	});

	it("does not take a non-console page on the apex for the console", async () => {
		const marketing = client(`${APEX}/agents/coder/`);
		const sw = worker(APEX, [marketing]);
		await sw.click(LINK);
		expect(marketing.navigated).toEqual([]);
		expect(sw.opened).toEqual([LINK]);
	});

	it("a notification with no link opens the feed, never the bare home screen", async () => {
		const apex = worker(APEX);
		await apex.click(undefined);
		expect(apex.opened).toEqual(["/console/notifications"]);
		const sub = worker(CONSOLE);
		await sub.click(undefined);
		expect(sub.opened).toEqual(["/notifications"]);
	});
});

describe("the push handler (#897)", () => {
	it("shows the notification with the producer's link and its per-subject tag", async () => {
		const sw = worker(APEX);
		await sw.push({ title: "🙋 Coder needs you", body: "b", url: LINK, tag: `coding:${LINK}` });
		expect(sw.shown).toHaveLength(1);
		expect(sw.shown[0]?.options.tag).toBe(`coding:${LINK}`);
		expect(sw.shown[0]?.options.data.url).toBe(LINK);
	});

	it("hands it to a visible console tab on the console host instead of the tray", async () => {
		const tab = client(`${CONSOLE}/instances`, "visible");
		const sw = worker(CONSOLE, [tab]);
		await sw.push({ title: "t", body: "b", url: LINK, tag: "coding:x" });
		expect(sw.shown).toEqual([]);
		expect(tab.messages).toHaveLength(1);
	});
});
