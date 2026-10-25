/** #1192 — a runner-only sign-in: asked for with --runner-only, recognised from the token, and the session file kept private. */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceLogin, sessionScope } from "./login-device.js";

const token = (payload: Record<string, unknown>) => `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

describe("sessionScope", () => {
	it("reads runner-only from the token's own payload; anything else is a full sign-in", () => {
		expect(sessionScope(token({ uid: "u", scope: "runner", exp: 1 }))).toBe("runner");
		expect(sessionScope(token({ uid: "u", exp: 1 }))).toBeNull();
		expect(sessionScope(token({ uid: "u", scope: "admin" }))).toBeNull();
		expect(sessionScope("not a token")).toBeNull();
		expect(sessionScope("")).toBeNull();
	});
});

describe("deviceLogin --runner-only", () => {
	const run = async (scope?: "runner") => {
		const bodies: unknown[] = [];
		const fetchFn = (async (url: string, init?: RequestInit) => {
			if (String(url).endsWith("/device/start")) {
				bodies.push(JSON.parse(String(init?.body)));
				return new Response(JSON.stringify({ device_code: "d", user_code: "BCDF-GHJK", verification_uri: "https://x/device", verification_uri_complete: "https://x/device?c=1", expires_in: 600, interval: 1 }));
			}
			return new Response(JSON.stringify({ session: "SESSION" }));
		}) as unknown as typeof fetch;
		const session = await deviceLogin({ apiBase: "https://api", node: "dell", fetch: fetchFn, sleep: async () => undefined, log: () => undefined, ...(scope ? { scope } : {}) });
		return { session, body: bodies[0] as Record<string, unknown> };
	};
	it("asks the platform for a runner-only sign-in, naming the machine", async () => {
		const { session, body } = await run("runner");
		expect(session).toBe("SESSION");
		expect(body).toEqual({ node: "dell", scope: "runner" });
	});
	it("asks for nothing extra by default", async () => {
		expect((await run()).body).toEqual({ node: "dell" });
	});
});

describe.skipIf(process.platform === "win32")("the session file is private to the owner", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pags-home-"));
		vi.stubEnv("HOME", home);
		vi.resetModules();
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});
	const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
	it("writes the file 0600 in a directory 0700", async () => {
		const { saveSession } = await import("./login.js");
		saveSession({ token: "t", user: { id: "u", login: "u", avatar: "" }, expiresAt: Date.now() + 1000 });
		const dir = join(home, ".config", "proagentstore");
		expect(mode(dir)).toBe("700");
		expect(mode(join(dir, "session.json"))).toBe("600");
	});
	it("tightens a session file an older version wrote world-readable", async () => {
		const dir = join(home, ".config", "proagentstore");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(dir, { recursive: true, mode: 0o755 });
		writeFileSync(join(dir, "session.json"), "{}", { mode: 0o644 });
		const { saveSession } = await import("./login.js");
		saveSession({ token: "t", user: { id: "u", login: "u", avatar: "" }, expiresAt: Date.now() + 1000 });
		expect(mode(join(dir, "session.json"))).toBe("600");
		expect(mode(dir)).toBe("700");
	});
});
