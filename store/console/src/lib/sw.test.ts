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

/**
 * A permission-request push (#1009), with the exact link `instancePermissionsLink` builds. SIMULATED:
 * this runs `store/sw.js` itself against a fake worker scope — the installed web app's push path on
 * iOS (home-screen PWA, 16.4+) and Android Chrome is this same worker. It is not real-device evidence;
 * a person still has to tap a real push on each device.
 */
describe("a permission-request push opens the exact control (#1009, simulated devices)", () => {
	const PERMISSION = "/console/instances/i1/settings?focus=permissions&permission_request=req-1";
	const ON_CONSOLE_HOST = "/instances/i1/settings?focus=permissions&permission_request=req-1";
	const TAG = `permission:${PERMISSION}`;

	it("shows one tray entry per request, carrying the exact control link", async () => {
		const sw = worker(APEX);
		await sw.push({ title: "Permission needed: GitHub write", body: "b", url: PERMISSION, tag: TAG });
		await sw.push({ title: "Permission needed: GitHub write", body: "b", url: "/console/instances/i1/settings?focus=permissions&permission_request=req-2", tag: "permission:/console/instances/i1/settings?focus=permissions&permission_request=req-2" });
		expect(sw.shown.map((n) => n.options.data.url)).toEqual([PERMISSION, "/console/instances/i1/settings?focus=permissions&permission_request=req-2"]);
		expect(new Set(sw.shown.map((n) => n.options.tag)).size).toBe(2);
	});

	it("cold (app closed): opens the exact request on either host, query intact", async () => {
		for (const [origin, expected] of [[APEX, PERMISSION], [CONSOLE, ON_CONSOLE_HOST]] as const) {
			const sw = worker(origin);
			await sw.click(PERMISSION);
			expect(sw.opened).toEqual([expected]);
		}
	});

	it("warm (a console tab open): moves and focuses that tab — no second window — on either host", async () => {
		for (const [origin, tabUrl, expected] of [[APEX, `${APEX}/console/instances`, PERMISSION], [CONSOLE, `${CONSOLE}/instances`, ON_CONSOLE_HOST]] as const) {
			const tab = client(tabUrl);
			const sw = worker(origin, [tab]);
			await sw.click(PERMISSION);
			expect(tab.navigated).toEqual([expected]);
			expect(tab.focused).toBe(true);
			expect(sw.opened).toEqual([]);
		}
	});

	it("a visible console tab gets the push in-app, not a tray banner", async () => {
		const tab = client(`${CONSOLE}/instances/i1`, "visible");
		const sw = worker(CONSOLE, [tab]);
		await sw.push({ title: "Permission needed", body: "b", url: PERMISSION, tag: TAG });
		expect(sw.shown).toEqual([]);
		expect(tab.messages).toHaveLength(1);
	});

	it("signed out: the page the worker opens survives sign-in exactly, on either host", async () => {
		const { withoutSessionParam } = await import("./auth");
		for (const [origin, expected] of [[APEX, PERMISSION], [CONSOLE, ON_CONSOLE_HOST]] as const) {
			const sw = worker(origin);
			await sw.click(PERMISSION);
			// The OAuth callback lands on the opened page with `session=` added; sign-in strips only that.
			expect(withoutSessionParam(`${origin}${sw.opened[0]}&session=JWT`)).toBe(expected);
		}
	});

	it("duplicate taps land on the same exact control and never open a second window over an open tab", async () => {
		const tab = client(`${APEX}/console/instances`);
		const sw = worker(APEX, [tab]);
		await sw.click(PERMISSION);
		await sw.click(PERMISSION);
		expect(tab.navigated).toEqual([PERMISSION, PERMISSION]);
		expect(sw.opened).toEqual([]);
	});

	it("the link carries only opaque ids — no owner, token or credential for a wrong owner to replay", () => {
		const url = new URL(PERMISSION, APEX);
		expect([...url.searchParams.keys()].sort()).toEqual(["focus", "permission_request"]);
		expect(PERMISSION).not.toMatch(/token|session|secret|key|user|owner/i);
	});
});
