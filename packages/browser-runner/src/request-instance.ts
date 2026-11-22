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
import type { LocalRunner } from "./runner.js";

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

/** The runtime task a request is about: `/tasks/<id>…`, `/takeover/<id>/…`, or a `/browser/*` body's `taskId`. */
export function taskIdOf(path: string, body: { taskId?: unknown } | undefined): string | null {
	const m = path.match(/^\/(?:tasks|takeover)\/([^/]+)/);
	if (m) return decodeURIComponent(m[1]);
	return path.startsWith("/browser/") && typeof body?.taskId === "string" && body.taskId ? body.taskId : null;
}

const LOCAL_RUN = /^\/local-(browser|apply|artifact)\//;

/** The instance that started the local run a `/local-*` request names, if this runner still holds it. */
function localRunOwner(runner: LocalRunner, path: string, body: Record<string, unknown>): string | undefined {
	const id = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : "");
	if (path.startsWith("/local-apply/reconciliation/")) return runner.localApplyReconciliation.instanceOfRun(id("reconciliationId"));
	const runtime = path.startsWith("/local-browser/") ? runner.localBrowser : path.startsWith("/local-artifact/") ? runner.localArtifact : runner.localApply;
	return runtime.instanceOfRun(id("runId"));
}

/**
 * Why `caller` may not reach the runtime task or local run this request names, or null (#1194).
 *
 * A task records the instance whose socket created it (`RunnerTask.instanceId`), and a local run's envelope
 * names its instance. Another agent's socket naming either is refused, and so is starting a local run in
 * another instance's name. An unbound task, an id this runner does not hold, and a local caller are not refused.
 */
export async function boundWorkRefusal(runner: LocalRunner, req: IncomingMessage, path: string, caller: string | undefined): Promise<string | null> {
	if (!caller) return null;
	const readsBody = req.method === "POST" && (path.startsWith("/browser/") || LOCAL_RUN.test(path));
	const body = readsBody ? await readJson<Record<string, unknown> | null>(req) : undefined;
	const taskId = taskIdOf(path, body ?? undefined);
	const taskOwner = taskId ? runner.store.getTask(taskId)?.instanceId : undefined;
	if (taskOwner && taskOwner !== caller) return `Task ${taskId} belongs to another agent on this machine; a request from this agent cannot reach it.`;
	if (!body || typeof body !== "object" || !LOCAL_RUN.test(path)) return null;
	const named = typeof body.instanceId === "string" ? body.instanceId : undefined;
	const owner = localRunOwner(runner, path, body);
	if ((named && named !== caller) || (owner && owner !== caller)) return "This local run belongs to another agent on this machine; a request from this agent cannot reach it.";
	return null;
}

/** Is this task visible to `caller` — its own, unbound, or no caller instance (#1194)? */
export function taskVisibleTo(runner: LocalRunner, taskId: string, caller: string | undefined): boolean {
	const owner = runner.store.getTask(taskId)?.instanceId;
	return !owner || !caller || owner === caller;
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
