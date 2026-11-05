#!/usr/bin/env node
/** Record native stdio MCP traffic without filtering or rewriting its bytes. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { constants } from "node:os";
import { basename, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const split = process.argv.indexOf("--");
if (split !== 3 || !process.argv[split + 1]) {
	process.stderr.write("Usage: node mcp-recording-proxy.mjs LOG_DIRECTORY -- COMMAND [ARG...]\n");
	process.exit(2);
}
const dir = resolve(process.argv[2]);
const fds = [];
function open(name) { const fd = openSync(join(dir, name), "wx", 0o600); fds.push(fd); return fd; }
function write(fd, bytes) {
	const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
	let offset = 0;
	while (offset < buffer.length) {
		const written = writeSync(fd, buffer, offset, buffer.length - offset);
		if (!written) throw new Error("Recording write made no progress");
		offset += written;
	}
}
let raw, events;
try {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error("Recording directory must be a plain directory");
	chmodSync(dir, 0o700);
	raw = { request: open("client-to-server.raw"), response: open("server-to-client.raw"), stderr: open("native-stderr.raw") };
	events = open("events.jsonl");
} catch (error) {
	for (const fd of fds) closeSync(fd);
	process.stderr.write(`Recorder setup failed: ${error.message}\n`);
	process.exit(1);
}
function record(event) { write(events, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`); }
const pending = new Map();
const decoders = { request: new StringDecoder("utf8"), response: new StringDecoder("utf8") };
const buffers = { request: "", response: "" };
function line(direction, value) {
	if (!value.trim()) return;
	try {
		const message = JSON.parse(value);
		const key = `${direction}:${JSON.stringify(message.id)}`;
		if (message.method) {
			if (message.id !== undefined) pending.set(key, { method: message.method, tool: message.params?.name ?? null });
			record({ direction, id: message.id ?? null, method: message.method, tool: message.params?.name ?? null, params: message.params ?? null });
		} else {
			const other = `${direction === "request" ? "response" : "request"}:${JSON.stringify(message.id)}`;
			const request = pending.get(other); pending.delete(other);
			const content = Array.isArray(message.result?.content) ? message.result.content : [];
			const images = content.filter((item) => item.type === "image").map((item) => {
				const bytes = Buffer.from(item.data ?? "", "base64");
				return { mimeType: item.mimeType, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
			});
			record({ direction, id: message.id ?? null, method: request?.method ?? null, tool: request?.tool ?? null, jsonRpcError: message.error ?? null, isError: message.result?.isError ?? false, imageCount: images.length, images, text: content.filter((item) => item.type === "text").map((item) => item.text), tools: message.result?.tools ?? null });
		}
	} catch (error) { record({ direction, parseError: error.message, decodedBytes: Buffer.byteLength(value) }); }
}
function inspect(direction, bytes, end = false) {
	buffers[direction] += end ? decoders[direction].end() : decoders[direction].write(bytes);
	let newline = buffers[direction].indexOf("\n");
	while (newline !== -1) {
		line(direction, buffers[direction].slice(0, newline)); buffers[direction] = buffers[direction].slice(newline + 1);
		newline = buffers[direction].indexOf("\n");
	}
	if (end && buffers[direction]) { line(direction, buffers[direction]); buffers[direction] = ""; }
}
const command = process.argv[split + 1];
// Arguments and environment are deliberately absent: either can contain credentials.
record({ channel: "process", state: "starting", executable: basename(command), pid: process.pid });
const child = spawn(command, process.argv.slice(split + 2), { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let proxyFailed = false;
function failure(channel, error) {
	proxyFailed = true;
	process.exitCode = 1;
	try { record({ channel, error: error.message }); } catch { /* A failed recording cannot record its own failure. */ }
	child.kill("SIGTERM");
}
process.stdin.on("data", (bytes) => {
	try { write(raw.request, bytes); inspect("request", bytes); if (!child.stdin.write(bytes)) process.stdin.pause(); }
	catch (error) { failure("client_input", error); }
});
child.stdin.on("drain", () => process.stdin.resume());
process.stdin.on("end", () => { inspect("request", null, true); child.stdin.end(); });
process.stdin.on("error", (error) => failure("client_input", error));
child.stdin.on("error", (error) => { failure("native_input", error); process.stdin.pause(); });
child.stdout.on("data", (bytes) => {
	try { write(raw.response, bytes); inspect("response", bytes); if (!process.stdout.write(bytes)) child.stdout.pause(); }
	catch (error) { failure("native_output", error); }
});
process.stdout.on("drain", () => child.stdout.resume());
process.stdout.on("error", (error) => failure("client_output", error));
child.stdout.on("error", (error) => failure("native_output", error));
child.stderr.on("data", (bytes) => {
	try { write(raw.stderr, bytes); if (!process.stderr.write(bytes)) child.stderr.pause(); }
	catch (error) { failure("native_stderr", error); }
});
process.stderr.on("drain", () => child.stderr.resume());
process.stderr.on("error", (error) => failure("client_stderr", error));
child.stderr.on("error", (error) => failure("native_stderr", error));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { proxyFailed = true; record({ channel: "process", error: error.message }); });
// `exit` can precede the final stdout/stderr bytes. `close` waits for both pipes to drain.
child.on("close", (code, signal) => {
	try {
		inspect("request", null, true); inspect("response", null, true);
		record({ channel: "process", state: "closed", exitCode: code, signal });
	} finally {
		for (const fd of fds) closeSync(fd);
		process.exitCode = proxyFailed ? 1 : code ?? (128 + (constants.signals[signal] ?? 0));
		process.stdin.pause();
	}
});
