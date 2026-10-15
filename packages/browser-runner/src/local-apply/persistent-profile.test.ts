/**
 * #1094 — the application browser profile PERSISTS on this machine, in real Chromium.
 *
 * Until #1094 an `isolated` application run drove a throwaway `runDir/profile`, so a sign-in done in
 * one run was gone by the next. Here a local site sets a sign-in cookie in one run's browser; a
 * second run on the same profile sends it back, and the ledger reads it as a live session — the
 * exact chain a SEEK sign-in done once via takeover depends on.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applicationProfileDir, createPersistentApplyBrowser } from "./live-run-browser.js";
import type { RunBrowser } from "./runtime.js";

let server: Server;
let base: string;
let dataDir: string;
const seen: Array<{ path: string; cookie: string }> = [];

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), "apply-profile-"));
	server = createServer((req, res) => {
		seen.push({ path: req.url ?? "", cookie: req.headers.cookie ?? "" });
		if (req.url === "/sign-in") res.setHeader("Set-Cookie", "auth=token-value; Max-Age=3600; Path=/; HttpOnly");
		res.setHeader("Content-Type", "text/html");
		res.end("<title>ok</title><p>ok</p>");
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
	await new Promise((done) => server.close(done));
	rmSync(dataDir, { recursive: true, force: true });
});

const open = () => {
	const dir = applicationProfileDir(dataDir, "isolated");
	return createPersistentApplyBrowser(join(dir, "browser"), join(dir, "site-sessions.json"), true);
};

describe("the isolated application profile persists between runs (#1094)", () => {
	it("a sign-in cookie set in one run is sent by the next run, and the ledger sees the session", async () => {
		const first: RunBrowser = await open();
		try {
			await first.sessions!.beginSignIn("localhost");
			await first.tools.callTool("browser_navigate", { url: `${base}/sign-in` });
			expect(await first.sessions!.completeSignIn("localhost")).toEqual({ fingerprint: 1, verifiable: true });
			// One profile, one run at a time: a concurrent launch is refused plainly, not left to Chrome's lock.
			await expect(open()).rejects.toThrow(/in use by another run/);
		} finally {
			await first.stop();
		}

		const second = await open();
		try {
			await second.tools.callTool("browser_navigate", { url: `${base}/job` });
			expect(seen.find((r) => r.path === "/job")?.cookie).toContain("auth=token-value");
			expect(await second.sessions!.check(`${base}/job`)).toEqual({ state: "ok", site: "localhost" });
		} finally {
			await second.stop();
		}
	}, 120_000);
});
