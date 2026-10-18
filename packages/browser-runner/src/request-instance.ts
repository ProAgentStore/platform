/**
 * Which agent a request to this runtime came from, and what it may touch (#1164).
 *
 * One `pags up` serves every agent on the machine. `runner connect` stamps each relayed request with the
 * instance whose relay SOCKET it arrived on — never a value from the command — so the header is the
 * instance the cloud authenticated that socket for. A local caller (`pags runner status`, the update
 * controller) sends none: that is the owner at their own machine.
 */
import type { IncomingMessage } from "node:http";
import type { CodingRuntime } from "./coding/runtime.js";
import { RunnerInputError } from "./errors.js";

/** The relayed instance id header, or undefined. */
export function instanceOf(req: IncomingMessage): string | undefined {
	const raw = req.headers["x-pags-instance-id"];
	const id = (Array.isArray(raw) ? raw[0] : raw)?.trim();
	return id || undefined;
}

/** The coding session a `/coding/*` request is about: its body's `sessionId`, or the takeover path's id. */
export function codingSessionIdOf(path: string, body: { sessionId?: unknown } | undefined): string | null {
	const m = path.match(/^\/coding\/takeover\/([^/]+)\//);
	if (m) return decodeURIComponent(m[1]);
	return typeof body?.sessionId === "string" && body.sessionId ? body.sessionId : null;
}

/** Why `caller` may not reach the coding session this request names, or null. */
export async function codingSessionRefusal(coding: CodingRuntime, req: IncomingMessage, path: string, caller: string | undefined): Promise<string | null> {
	if (!path.startsWith("/coding/")) return null;
	const sessionId = codingSessionIdOf(path, req.method === "POST" ? await readJson<{ sessionId?: unknown }>(req) : undefined);
	return sessionId ? coding.instanceRefusal(sessionId, caller) : null;
}

/** A body read once and kept, so the session guard and the route handler both see it. */
const bodies = new WeakMap<IncomingMessage, unknown>();

export async function readJson<T>(req: IncomingMessage): Promise<T> {
	if (bodies.has(req)) return bodies.get(req) as T;
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	const raw = Buffer.concat(chunks).toString("utf-8");
	let parsed: unknown = {};
	if (raw) {
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new RunnerInputError("Request body must be valid JSON");
		}
	}
	bodies.set(req, parsed);
	return parsed as T;
}
