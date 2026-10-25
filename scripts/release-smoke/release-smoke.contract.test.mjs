/** #1152 — the release gate is wired the way the issue asks: blocking, Linux + Windows only, and publish waits for it. */
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = readFileSync(join(here, "..", "..", ".github", "workflows", "publish-npm.yml"), "utf8");
const job = (name) => {
	const start = WORKFLOW.indexOf(`\n  ${name}:`);
	expect(start, `job ${name} exists`).toBeGreaterThan(-1);
	const next = WORKFLOW.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
	return WORKFLOW.slice(start, next === -1 ? undefined : start + 1 + next);
};

describe("Publish to npm: the release smoke test", () => {
	const linux = job("smoke-linux");
	const windows = job("smoke-windows");
	it("runs on GitHub-hosted Linux and Windows images, pinned, and not on macOS", () => {
		expect(linux).toMatch(/runs-on: ubuntu-24\.04/);
		expect(windows).toMatch(/runs-on: windows-2022/);
		// no job runs on a macOS image (the word may appear in a comment explaining why)
		expect([...WORKFLOW.matchAll(/^\s*runs-on:\s*(.+)$/gm)].map((m) => m[1])).not.toContainEqual(expect.stringMatching(/macos/i));
	});
	for (const [name, text] of [["Linux", linux], ["Windows", windows]]) {
		it(`${name}: builds the candidate and runs the smoke script, with a time limit`, () => {
			expect(text).toContain("pnpm --filter @proagentstore/cli build");
			expect(text).toContain("node scripts/release-smoke/run.mjs");
			expect(text).toMatch(/timeout-minutes: \d+/);
			expect(text).not.toMatch(/continue-on-error/);
			expect(text).not.toContain("npm publish");
		});
	}
	it("blocks the publish on BOTH: nothing is published unless each passed", () => {
		expect(job("publish")).toMatch(/needs: \[smoke-linux, smoke-windows\]/);
	});
	it("re-runs when the smoke test itself changes", () => {
		expect(WORKFLOW).toContain("'scripts/release-smoke/**'");
	});
});

describe("the redirect hook", () => {
	const hook = pathToFileURL(join(here, "redirect.mjs")).href;
	/** Run `code` in a child with the hook preloaded and SMOKE_API set (or not), against a server that records what reaches it. */
	async function withServer(code, smokeApi) {
		const seen = [];
		const server = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.end("{}"); });
		server.on("upgrade", (req, socket) => { seen.push(`UPGRADE ${req.url}`); socket.destroy(); });
		await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
		const base = `http://127.0.0.1:${server.address().port}`;
		try {
			await new Promise((ok) => {
				const child = spawn(process.execPath, ["--import", hook, "--input-type=module", "-e", code], { env: { ...process.env, NODE_OPTIONS: "", ...(smokeApi ? { SMOKE_API: base } : {}) }, stdio: "ignore" });
				child.on("close", ok);
			});
		} finally {
			server.closeAllConnections?.();
			await new Promise((ok) => server.close(ok));
		}
		return seen;
	}
	const FETCH = `try { await fetch("https://api.proagentstore.online/v1/instances/my/instances", { method: "POST", body: "{}" }); } catch {}`;
	const SOCKET = `const ws = new WebSocket("wss://api.proagentstore.online/v1/relay/i1/connect?token=t"); await new Promise((r) => { ws.onerror = r; ws.onclose = r; setTimeout(r, 3000); });`;

	it("sends the platform's address to SMOKE_API for fetch, keeping the method and path", async () => {
		expect(await withServer(FETCH, true)).toEqual(["POST /v1/instances/my/instances"]);
	});
	it("sends a relay WebSocket there too", async () => {
		expect(await withServer(SOCKET, true)).toEqual(["UPGRADE /v1/relay/i1/connect?token=t"]);
	});
	it("does nothing unless SMOKE_API is set: the platform's address is not touched", async () => {
		expect(await withServer(`globalThis.fetch.toString().includes("startsWith") && console.error("patched")`, false)).toEqual([]);
		const out = execFileSync(process.execPath, ["--import", hook, "-e", "console.log(String(globalThis.fetch).includes('FROM'))"], { env: { ...process.env, SMOKE_API: "", NODE_OPTIONS: "" }, encoding: "utf8" });
		expect(out.trim()).toBe("false");
	});
});
