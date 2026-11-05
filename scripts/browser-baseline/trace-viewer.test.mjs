import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("serves only a fixed private trace with a loopback URL capability and no raw downloads", async () => {
	const root = mkdtempSync(join(tmpdir(), "pags-trace-viewer-"));
	const log = join(root, "events.jsonl"), raw = join(root, "client-to-server.raw");
	const content = `${Array.from({ length: 205 }, (_, seq) => JSON.stringify({ seq, text: "<script>untrusted page</script>" })).join("\n")}\n{"partial":`;
	writeFileSync(log, content); writeFileSync(raw, "private raw input");
	const child = spawn(process.execPath, [fileURLToPath(new URL("./trace-viewer.mjs", import.meta.url)), root], { stdio: ["ignore", "pipe", "pipe"] });
	const closed = new Promise((resolve) => child.on("close", resolve));
	try {
		const base = await new Promise((resolve, reject) => {
			let output = "";
			child.on("error", reject); child.on("exit", () => reject(new Error("Viewer exited before opening")));
			child.stdout.on("data", (bytes) => { output += bytes; if (output.includes("\n")) resolve(output.trim()); });
		});
		const url = new URL(base);
		expect(url.hostname).toBe("127.0.0.1"); expect(url.pathname).toMatch(/^\/[a-f0-9]{48}\/$/);
		const html = await fetch(base);
		expect(html.status).toBe(200); expect(html.headers.get("cache-control")).toBe("no-store");
		expect(html.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		const events = await (await fetch(`${base}events`)).json();
		expect(events.total).toBe(205); expect(events.events).toHaveLength(200);
		expect(events.events[0].seq).toBe(5); expect(events.events.at(-1).seq).toBe(204);
		expect((await fetch(`${url.origin}/`)).status).toBe(404);
		expect((await fetch(`${base}client-to-server.raw`)).status).toBe(404);
		expect((await fetch(`${base}events?path=../client-to-server.raw`)).status).toBe(404);
		expect((await fetch(`${base}events`, { method: "POST" })).status).toBe(405);
		expect(readFileSync(log, "utf8")).toBe(content);
		unlinkSync(log); symlinkSync(raw, log);
		expect((await fetch(`${base}events`)).status).toBe(503);
	} finally { child.kill("SIGTERM"); await closed; rmSync(root, { recursive: true, force: true }); }
}, 30000);
