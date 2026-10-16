/** #1105: the live view's back, forward, reload and address bar move the taken-over page — and nothing else. */
import { describe, expect, it } from "vitest";
import { takeoverNavigation, takeoverUrl } from "./takeover-nav.js";

function fakePage(fail = false) {
	const calls: Array<[string, unknown?]> = [];
	const act = (name: string) => async (arg?: unknown) => {
		calls.push(arg === undefined || typeof arg === "object" ? [name] : [name, arg]);
		if (fail) throw new Error("Timeout 15000ms exceeded");
		return null;
	};
	return { page: { goBack: act("goBack"), goForward: act("goForward"), reload: act("reload"), goto: act("goto") } as never, calls };
}

describe("the live view's browser controls (#1105)", () => {
	it("back, forward and reload drive the page", async () => {
		const { page, calls } = fakePage();
		for (const type of ["back", "forward", "reload"] as const) expect(await takeoverNavigation(page, { type })).toBe(true);
		expect(calls.map((c) => c[0])).toEqual(["goBack", "goForward", "reload"]);
	});

	it("the address bar opens an http(s) address, adding https:// to a bare host as a browser does", async () => {
		const { page, calls } = fakePage();
		await takeoverNavigation(page, { type: "navigate", url: "login.seek.com/login" });
		expect(calls).toEqual([["goto", "https://login.seek.com/login"]]);
	});

	it("refuses an address that would reach the machine rather than move the page", async () => {
		const { page, calls } = fakePage();
		for (const url of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "", "two words"]) {
			await expect(takeoverNavigation(page, { type: "navigate", url })).rejects.toThrow(/http\(s\) address/);
		}
		expect(calls).toEqual([]);
	});

	it("a slow page is not an input failure: the frame poll shows where it landed", async () => {
		const { page } = fakePage(true);
		await expect(takeoverNavigation(page, { type: "reload" })).resolves.toBe(true);
	});

	it("leaves every other input to the mouse and keyboard relay", async () => {
		const { page, calls } = fakePage();
		expect(await takeoverNavigation(page, { type: "click", x: 1, y: 2 })).toBe(false);
		expect(calls).toEqual([]);
	});

	it("takeoverUrl accepts what an address bar does, and only that", () => {
		expect(takeoverUrl("https://au.seek.com/job/95289924")).toBe("https://au.seek.com/job/95289924");
		expect(takeoverUrl(" seek.com.au ")).toBe("https://seek.com.au/");
		expect(takeoverUrl("http://localhost:3000/x")).toBe("http://localhost:3000/x");
		expect(takeoverUrl("data:text/html,hi")).toBeNull();
		expect(takeoverUrl(42)).toBeNull();
	});
});
