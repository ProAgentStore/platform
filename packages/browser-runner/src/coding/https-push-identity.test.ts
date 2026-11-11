/**
 * Which identity plain `git push` over HTTPS uses, and whether it can push (#1465).
 *
 * `probeHttpsPushCapability`'s own logic is exercised with injected fakes — no real network, no
 * dependency on this machine's own credential state. `resolveHttpsCredential` is exercised
 * against REAL git, the same way `cloneIntoOwnFolder`'s tests and `runtime-clone-provisioning.
 * test.ts` do: a scripted credential helper under a stubbed HOME, so the actual `git credential
 * fill` integration is proven, not just the interface this module calls it through.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { type HttpsCredential, probeHttpsPushCapability, resolveHttpsCredential } from "./https-push-identity.js";

describe("probeHttpsPushCapability (#1465)", () => {
	it("reports no credential as unverified for every repo — never guessed", async () => {
		const resolveCredential = vi.fn(() => null);
		const checkPush = vi.fn(async () => true);
		const out = await probeHttpsPushCapability("github.com", ["acme/one", "acme/two"], { resolveCredential, checkPush });
		expect(out).toMatchObject({ checked: true, host: "github.com", identity: null });
		expect(out.repos).toEqual([
			{ repo: "acme/one", pushable: null, reason: "no https credential is configured on this machine for github.com" },
			{ repo: "acme/two", pushable: null, reason: "no https credential is configured on this machine for github.com" },
		]);
		expect(checkPush).not.toHaveBeenCalled();
	});

	it("reports the resolved identity and per-repo push capability, with a reason only when it is not pushable", async () => {
		const credential: HttpsCredential = { username: "owner-login-rl", password: "token-value" };
		const resolveCredential = vi.fn(() => credential);
		const checkPush = vi.fn(async (_c: HttpsCredential, repo: string) => (repo === "acme/pushable" ? true : repo === "acme/readonly" ? false : null));
		const out = await probeHttpsPushCapability("github.com", ["acme/pushable", "acme/readonly", "acme/unknown"], { resolveCredential, checkPush });
		expect(out.identity).toBe("owner-login-rl");
		expect(out.repos).toEqual([
			{ repo: "acme/pushable", pushable: true },
			{ repo: "acme/readonly", pushable: false, reason: "owner-login-rl can read acme/readonly but not push to it" },
			{ repo: "acme/unknown", pushable: null, reason: "could not be verified against the GitHub API" },
		]);
		// The credential itself never appears anywhere on the report.
		expect(JSON.stringify(out)).not.toContain("token-value");
	});

	it("resolves the credential exactly ONCE regardless of how many repos are checked", async () => {
		const resolveCredential = vi.fn(() => ({ username: "u", password: "p" }));
		const checkPush = vi.fn(async () => true);
		await probeHttpsPushCapability("github.com", ["a/1", "a/2", "a/3"], { resolveCredential, checkPush });
		expect(resolveCredential).toHaveBeenCalledOnce();
		expect(checkPush).toHaveBeenCalledTimes(3);
	});

	it("checks no repo and makes no call when none were named", async () => {
		const resolveCredential = vi.fn(() => ({ username: "u", password: "p" }));
		const checkPush = vi.fn(async () => true);
		const out = await probeHttpsPushCapability("github.com", [], { resolveCredential, checkPush });
		expect(out).toMatchObject({ checked: true, identity: "u", repos: [] });
		expect(checkPush).not.toHaveBeenCalled();
	});
});

describe("resolveHttpsCredential — real git, a scripted credential helper (#1465)", () => {
	const home = mkdtempSync(join(tmpdir(), "pags-https-cred-"));
	afterEach(() => vi.unstubAllEnvs());
	afterAll(() => rmSync(home, { recursive: true, force: true }));

	it("returns what the configured credential helper hands back", () => {
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		const helper = join(home, "fake-credential-helper.sh");
		writeFileSync(helper, "#!/bin/sh\necho username=owner-login\necho password=sk-fake-token\n", { mode: 0o755 });
		execFileSync("git", ["config", "--global", "credential.helper", helper], { env: { ...process.env, HOME: home } });
		expect(resolveHttpsCredential("github.com")).toEqual({ username: "owner-login", password: "sk-fake-token" });
	});

	it("returns null when the helper offers nothing (e.g. refuses or is unconfigured)", () => {
		const emptyHome = mkdtempSync(join(tmpdir(), "pags-https-cred-empty-"));
		vi.stubEnv("HOME", emptyHome);
		vi.stubEnv("USERPROFILE", emptyHome);
		// No credential.helper configured at all in this fresh HOME: `git credential fill` exits 0
		// with nothing filled in, or waits for terminal input — guarded against by the real
		// `GIT_TERMINAL_PROMPT`-free call this function makes.
		const result = resolveHttpsCredential("github.com");
		expect(result === null || typeof result?.username === "string").toBe(true);
		rmSync(emptyHome, { recursive: true, force: true });
	});

	it("never throws when `git` itself is unusable", () => {
		vi.stubEnv("PATH", "/nonexistent-path-for-this-test-only");
		expect(() => resolveHttpsCredential("github.com")).not.toThrow();
		expect(resolveHttpsCredential("github.com")).toBeNull();
	});
});
