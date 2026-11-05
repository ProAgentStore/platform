#!/usr/bin/env node
/** Read-only loopback viewer for one fixed recording directory; no account or browser actions. */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

if (!process.argv[2]) { process.stderr.write("Usage: node trace-viewer.mjs LOG_DIRECTORY [PORT]\n"); process.exit(2); }
const root = resolve(process.argv[2]);
if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("Recording root must be a plain directory");
const path = join(root, "events.jsonl");
const port = Number(process.argv[3] ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid loopback port");
const prefix = `/${randomBytes(24).toString("hex")}`;
const nonce = randomBytes(16).toString("base64");
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Native MCP trace</title><style>body{font:14px system-ui;max-width:1100px;margin:24px auto;padding:0 12px;background:#12161d;color:#eee}pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #445;padding:12px;border-radius:8px}#status{color:#aab}</style><h1>Native MCP trace</h1><p>Read-only tool transport record. Arbitrary code inside a tool is not expanded into browser actions. Raw recordings stay on disk.</p><p id="status">Loading…</p><main id="events"></main><script nonce="${nonce}">async function refresh(){try{const response=await fetch('${prefix}/events',{cache:'no-store'});if(!response.ok)throw new Error('Recording unavailable');const data=await response.json();document.getElementById('status').textContent='Showing '+data.events.length+' of '+data.total+' complete records';const nodes=data.events.map(event=>{const pre=document.createElement('pre');pre.textContent=JSON.stringify(event,null,2);return pre});document.getElementById('events').replaceChildren(...nodes)}catch(error){document.getElementById('status').textContent=error.message}setTimeout(refresh,1000)}refresh()</script>`;
const server = createServer((req, res) => {
	res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'`);
	if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
	if (req.url === prefix || req.url === `${prefix}/`) { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); return; }
	if (req.url !== `${prefix}/events`) { res.writeHead(404); res.end(); return; }
	let fd;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		if (!fstatSync(fd).isFile()) throw new Error("Not a regular recording");
		const lines = readFileSync(fd, "utf8").split("\n"); lines.pop();
		const events = lines.slice(-200).map((line) => JSON.parse(line));
		res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify({ total: lines.length, events }));
	} catch { res.writeHead(503); res.end("Recording unavailable"); }
	finally { if (fd !== undefined) closeSync(fd); }
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`http://127.0.0.1:${server.address().port}${prefix}/\n`));
