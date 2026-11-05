import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const proxy = fileURLToPath(new URL("./mcp-recording-proxy.mjs", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function recordedSize(path, size) {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		try { if (statSync(path).size === size) return; } catch { /* The proxy may still be starting. */ }
		await wait(5);
	}
	throw new Error("Proxy did not record the first split chunk");
}
function run(args, env = process.env) {
	const child = spawn(process.execPath, [proxy, ...args], { stdio: ["pipe", "pipe", "pipe"], env });
	const out = [], err = [];
	child.stdout.on("data", (bytes) => out.push(bytes)); child.stderr.on("data", (bytes) => err.push(bytes));
	const closed = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal, out: Buffer.concat(out), err: Buffer.concat(err) })); });
	return { child, closed };
}

describe("native MCP recording proxy", () => {
	it("forwards exact bytes and records split UTF-8, typed ids, images, errors and final unterminated output", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pags-mcp-recorder-"));
		try {
			const log = join(dir, "logs"), fake = join(dir, "fake.mjs");
			const request = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "image", arguments: { text: "Málaga €🧪" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/call", params: { name: "error" } })}\n`);
			const image = Buffer.from([0, 255, 1, 2, 3]);
			const response = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "résultat €🧪" }, { type: "image", mimeType: "image/png", data: image.toString("base64") }] } })}\n${JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32000, message: "native failure" } })}\nnot-json\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/final", params: { text: "最後🧪" } })}`);
			const stderr = Buffer.concat([Buffer.from([255, 0, 128]), Buffer.alloc(256 * 1024, 120)]);
			writeFileSync(fake, `import {createHash} from 'node:crypto';import{writeFileSync,statSync}from'node:fs';const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);writeFileSync(${JSON.stringify(join(dir, "received.hash"))},createHash('sha256').update(Buffer.concat(chunks)).digest('hex'));const out=Buffer.from(${JSON.stringify(response.toString("base64"))},'base64');const split=out.indexOf(Buffer.from('🧪'))+1;process.stdout.write(out.subarray(0,split));while(statSync(${JSON.stringify(join(log, "server-to-client.raw"))}).size<split)await new Promise(r=>setTimeout(r,5));process.stdout.write(out.subarray(split));process.stderr.write(Buffer.from(${JSON.stringify(stderr.toString("base64"))},'base64'));process.exitCode=7;`);
			const { child, closed } = run([log, "--", process.execPath, fake, "argument-must-not-be-logged"], { ...process.env, RECORDER_TEST_SECRET: "environment-must-not-be-logged" });
			const split = request.indexOf(Buffer.from("🧪")) + 2;
			child.stdin.write(request.subarray(0, split)); await recordedSize(join(log, "client-to-server.raw"), split); child.stdin.end(request.subarray(split));
			const result = await closed;
			expect(result.code).toBe(7);
			expect(result.out.equals(response)).toBe(true); expect(result.err.equals(stderr)).toBe(true);
			expect(readFileSync(join(dir, "received.hash"), "utf8")).toBe(hash(request));
			for (const [name, bytes] of [["client-to-server.raw", request], ["server-to-client.raw", response], ["native-stderr.raw", stderr]]) {
				expect(readFileSync(join(log, name)).equals(bytes)).toBe(true);
				expect(statSync(join(log, name)).mode & 0o777).toBe(0o600);
			}
			expect(statSync(log).mode & 0o777).toBe(0o700);
			const recorded = readFileSync(join(log, "events.jsonl"), "utf8");
			const events = recorded.trim().split("\n").map(JSON.parse);
			expect(events.find((event) => event.direction === "request" && event.id === 1).params.arguments.text).toBe("Málaga €🧪");
			expect(events.find((event) => event.direction === "response" && event.id === 1)).toMatchObject({ tool: "image", isError: true, text: ["résultat €🧪"], images: [{ mimeType: "image/png", bytes: image.length, sha256: hash(image) }] });
			expect(events.find((event) => event.direction === "response" && event.id === "1")).toMatchObject({ tool: "error", jsonRpcError: { code: -32000, message: "native failure" } });
			expect(events.filter((event) => event.parseError)).toHaveLength(1);
			expect(events.find((event) => event.method === "notifications/final").params.text).toBe("最後🧪");
			expect(events.at(-1)).toMatchObject({ state: "closed", exitCode: 7 });
			expect(recorded).not.toContain("environment-must-not-be-logged"); expect(recorded).not.toContain("argument-must-not-be-logged");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	}, 30000);

	it("preserves existing recordings and reports spawn failures without pretending the native process ran", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pags-mcp-recorder-"));
		try {
			const first = run([dir, "--", join(dir, "missing-native-command")]); first.child.stdin.end();
			expect((await first.closed).code).toBe(1);
			const previous = readFileSync(join(dir, "events.jsonl"));
			expect(previous.toString()).toContain("ENOENT");
			const again = run([dir, "--", process.execPath, "-e", "process.stdout.write('must-not-start')"]); again.child.stdin.end();
			const result = await again.closed;
			expect(result.code).toBe(1); expect(result.out.length).toBe(0);
			expect(readFileSync(join(dir, "events.jsonl")).equals(previous)).toBe(true);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("drains backpressure in both directions without changing large non-JSON byte streams", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pags-mcp-recorder-"));
		try {
			const bytes = Buffer.alloc(2 * 1024 * 1024, 0xff);
			const { child, closed } = run([dir, "--", process.execPath, "-e", "process.stdin.pipe(process.stdout)"]);
			child.stdin.end(bytes);
			const result = await closed;
			expect(result.code).toBe(0); expect(result.out.equals(bytes)).toBe(true);
			expect(readFileSync(join(dir, "client-to-server.raw")).equals(bytes)).toBe(true);
			expect(readFileSync(join(dir, "server-to-client.raw")).equals(bytes)).toBe(true);
			const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
			expect(events.filter((event) => event.parseError).map((event) => event.direction).sort()).toEqual(["request", "response"]);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	}, 30000);
});
