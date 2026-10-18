/**
 * #1163 — `runner connect` holds the account session in memory, never in the environment its runtime
 * and engines inherit.
 */
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../login.js", () => ({ loadSession: () => ({ token: "from-session-json" }) }));

const { holdSessionToken, resetHeldSessionToken, sessionToken, takeSessionTokenFromEnv } = await import("./session-token.js");

afterEach(() => {
	resetHeldSessionToken();
	vi.unstubAllEnvs();
});

describe("the account session leaves the environment before anything is spawned (#1163)", () => {
	it("a PAGS_TOKEN it was started with is moved into memory: gone from the env, still the one it signs in with", () => {
		vi.stubEnv("PAGS_TOKEN", "explicit-caller-token");
		takeSessionTokenFromEnv();
		expect(process.env.PAGS_TOKEN).toBeUndefined();
		expect(sessionToken()).toBe("explicit-caller-token");
		// What the runtime is spawned with — `{ ...process.env }` — no longer carries it.
		const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.env.PAGS_TOKEN))"], { env: { ...process.env }, encoding: "utf8" });
		expect(child.stdout).toBe("undefined");
	});

	it("with nothing in the env, it reads session.json — what `pags up` now relies on instead of passing the token", () => {
		vi.stubEnv("PAGS_TOKEN", "");
		takeSessionTokenFromEnv();
		expect(sessionToken()).toBe("from-session-json");
	});

	it("a refreshed session replaces the held one, in memory (#1157)", () => {
		vi.stubEnv("PAGS_TOKEN", "old");
		takeSessionTokenFromEnv();
		holdSessionToken("refreshed");
		expect(sessionToken()).toBe("refreshed");
		expect(process.env.PAGS_TOKEN).toBeUndefined();
	});

	it("an explicit --pags-token still wins", () => {
		holdSessionToken("held");
		expect(sessionToken("flag-token")).toBe("flag-token");
	});
});
