/** #1157: `pags login --device` — which flow runs, reading a token's expiry, and the poll loop against a fake API. */
import { describe, expect, it, vi } from "vitest";
import { chooseLoginFlow, deviceLogin, sessionExpiresAt } from "./login-device.js";

const tokenWithExp = (exp: number) => `${Buffer.from(JSON.stringify({ uid: "u1", roles: ["user"], iat: 0, exp })).toString("base64url")}.sig`;

describe("which sign-in runs (#1157)", () => {
	it("the flags win", () => {
		expect(chooseLoginFlow({ device: true }, {}, "darwin").flow).toBe("device");
		expect(chooseLoginFlow({ browser: true }, { SSH_CONNECTION: "1 2 3 4" }, "linux").flow).toBe("browser");
	});
	it("an SSH session uses the device flow on every OS — the browser would open on the far machine, or nowhere", () => {
		for (const platform of ["darwin", "linux", "win32"] as const) {
			for (const v of ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"]) expect(chooseLoginFlow({}, { [v]: "x", DISPLAY: ":0" }, platform)).toEqual({ flow: "device", why: "this is an SSH session" });
		}
	});
	it("Linux with no X11 or Wayland display uses it too; a desktop does not", () => {
		expect(chooseLoginFlow({}, {}, "linux")).toEqual({ flow: "device", why: "there is no display here" });
		expect(chooseLoginFlow({}, { DISPLAY: ":0" }, "linux").flow).toBe("browser");
		expect(chooseLoginFlow({}, { WAYLAND_DISPLAY: "wayland-0" }, "linux").flow).toBe("browser");
		expect(chooseLoginFlow({}, {}, "darwin").flow).toBe("browser");
		expect(chooseLoginFlow({}, {}, "win32").flow).toBe("browser");
	});
});

describe("a session token's own expiry (#1157)", () => {
	it("is read from its payload, in ms; anything unreadable is null", () => {
		expect(sessionExpiresAt(tokenWithExp(1_800_000_000))).toBe(1_800_000_000_000);
		expect(sessionExpiresAt("garbage")).toBeNull();
		expect(sessionExpiresAt("")).toBeNull();
	});
});

describe("deviceLogin — the poll loop (#1157)", () => {
	const started = { device_code: "d".repeat(64), user_code: "BCDF-GHJK", verification_uri: "https://proagentstore.online/console/device", verification_uri_complete: "https://proagentstore.online/console/device?code=BCDF-GHJK", expires_in: 600, interval: 5 };
	const harness = (answers: Array<{ status: number; body: unknown } | Error>) => {
		let clock = 0;
		const sleeps: number[] = [];
		const lines: string[] = [];
		const calls: Array<{ url: string; body: unknown }> = [];
		const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
			if (url.endsWith("/start")) return new Response(JSON.stringify(started), { status: 200 });
			const next = answers.shift() ?? { status: 400, body: { error: "authorization_pending" } };
			if (next instanceof Error) throw next;
			return new Response(JSON.stringify(next.body), { status: next.status });
		});
		const run = () => deviceLogin({ apiBase: "https://api.test", node: "dell-laptop", fetch: fetchFn as never, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, now: () => clock, log: (l) => lines.push(l) });
		return { run, sleeps, lines, calls };
	};

	it("shows the link, the code and this machine's name, polls at the interval, and returns the approved session", async () => {
		const h = harness([{ status: 400, body: { error: "authorization_pending" } }, new Error("ECONNRESET"), { status: 200, body: { session: "the-session" } }]);
		expect(await h.run()).toBe("the-session");
		expect(h.calls[0]).toEqual({ url: "https://api.test/v1/auth/device/start", body: { node: "dell-laptop" } });
		expect(h.calls.slice(1).every((c) => c.url.endsWith("/v1/auth/device/token") && (c.body as { device_code: string }).device_code === started.device_code)).toBe(true);
		expect(h.sleeps).toEqual([5_000, 5_000, 5_000]); // a network blip is polled through
		expect(h.lines.join("\n")).toContain(started.verification_uri_complete);
		expect(h.lines.join("\n")).toContain("BCDF-GHJK");
		expect(h.lines.join("\n")).toContain("dell-laptop");
	});

	it("slows down by 5s each time it is told to", async () => {
		const h = harness([{ status: 400, body: { error: "slow_down" } }, { status: 400, body: { error: "slow_down" } }, { status: 200, body: { session: "s" } }]);
		await h.run();
		expect(h.sleeps).toEqual([5_000, 10_000, 15_000]);
	});

	it("a denial or an expired code ends it with the reason", async () => {
		await expect(harness([{ status: 400, body: { error: "access_denied" } }]).run()).rejects.toThrow(/denied/);
		await expect(harness([{ status: 400, body: { error: "expired_token" } }]).run()).rejects.toThrow(/expired.*pags login --device/);
	});

	it("gives up when the code's 10 minutes are over, however the server answers", async () => {
		const h = harness([]);
		await expect(h.run()).rejects.toThrow(/expired/);
		expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(600_000);
	});
});
