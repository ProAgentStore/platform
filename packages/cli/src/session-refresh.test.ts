/** #1157: a running `pags up` keeps its sign-in alive, and warns while there is still time when it cannot. */
import { describe, expect, it, vi } from "vitest";
import { CHECK_EVERY_MS, checkSession, refreshDecision, startSessionRefresh } from "./session-refresh.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const tok = (expMs: number) => `${Buffer.from(JSON.stringify({ uid: "u1", roles: ["user"], iat: 0, exp: expMs / 1000 })).toString("base64url")}.sig`;

function deps(token: string, answer: { status: number; body: unknown } | Error = { status: 200, body: { session: tok(NOW + 30 * DAY) } }) {
	const out = { refreshed: [] as Array<[string, string]>, logs: [] as string[], warns: [] as string[] };
	const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => {
		if (answer instanceof Error) throw answer;
		return new Response(JSON.stringify(answer.body), { status: answer.status });
	});
	return { out, fetchFn, d: { apiBase: "https://api.test", token: () => token, onRefreshed: (t: string, p: string) => out.refreshed.push([t, p]), log: (l: string) => out.logs.push(l), warn: (l: string) => out.warns.push(l), fetch: fetchFn as never, now: () => NOW } };
}

describe("when a session is refreshed (#1157)", () => {
	it("in its last 7 days; not before; an expired or unreadable one cannot be", () => {
		expect(refreshDecision(NOW + 8 * DAY, NOW)).toBe("fresh");
		expect(refreshDecision(NOW + 7 * DAY, NOW)).toBe("refresh");
		expect(refreshDecision(NOW + 60_000, NOW)).toBe("refresh");
		expect(refreshDecision(NOW, NOW)).toBe("expired");
		expect(refreshDecision(null, NOW)).toBe("unreadable");
	});
});

describe("checkSession (#1157)", () => {
	it("a fresh session is left alone — no request at all", async () => {
		const h = deps(tok(NOW + 20 * DAY));
		expect(await checkSession(h.d)).toEqual({ decision: "fresh" });
		expect(h.fetchFn).not.toHaveBeenCalled();
	});

	it("inside 7 days it swaps the token with its own bearer, hands the new one over with the old, and says until when", async () => {
		const old = tok(NOW + 5 * DAY);
		const h = deps(old);
		expect(await checkSession(h.d)).toEqual({ decision: "refresh", refreshed: true });
		const [url, init] = h.fetchFn.mock.calls[0];
		expect(url).toBe("https://api.test/v1/auth/session/refresh");
		expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${old}`);
		expect(h.out.refreshed).toEqual([[tok(NOW + 30 * DAY), old]]);
		expect(h.out.logs[0]).toMatch(/Session refreshed — signed in until \d{4}-\d\d-\d\d/);
		expect(h.out.warns).toEqual([]);
	});

	it("a refresh that fails with days to spare is retried quietly at the next check", async () => {
		const h = deps(tok(NOW + 5 * DAY), new Error("ENOTFOUND"));
		expect(await checkSession(h.d)).toEqual({ decision: "refresh", refreshed: false });
		expect(h.out.warns).toEqual([]);
	});

	it("inside 3 days a failed refresh warns, with the reason, the time left and how to sign in over SSH", async () => {
		const h = deps(tok(NOW + 30 * 3_600_000), { status: 403, body: { error: "Account suspended" } });
		await checkSession(h.d);
		expect(h.out.warns[0]).toMatch(/Session refresh failed \(Account suspended\): this runner signs out in 30 hours.*pags login --device/);
		expect(h.out.refreshed).toEqual([]);
	});

	it("an expired session says so — it cannot refresh itself", async () => {
		const h = deps(tok(NOW - 1));
		expect(await checkSession(h.d)).toEqual({ decision: "expired" });
		expect(h.fetchFn).not.toHaveBeenCalled();
		expect(h.out.warns[0]).toMatch(/Session expired.*pags login --device/);
	});
});

describe("startSessionRefresh (#1157)", () => {
	it("checks at once, then every 6 hours on a timer that never keeps the process alive", () => {
		const h = deps(tok(NOW + 20 * DAY));
		const unref = vi.fn();
		const every = vi.fn(() => ({ unref }));
		startSessionRefresh(h.d, every);
		expect(every).toHaveBeenCalledWith(expect.any(Function), CHECK_EVERY_MS);
		expect(unref).toHaveBeenCalled();
	});
});
