import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The tiny, best-effort runner state store: our session id → engine resume key. */
interface StateFile {
	[sessionId: string]: string;
}

export type StateEngine = "claude" | "codex";

/** Codex CLI emitted UUID-shaped `thread_id`s in the #730 proof; reject anything unsafe to argv. */
export function isCodexThreadId(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function stateKey(id: string, engine: StateEngine): string {
	return engine === "codex" ? `codex:${id}` : id;
}

function loadFile(path: string | undefined): StateFile {
	if (!path || !existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => (typeof value === "string" && value.trim() ? [[key, value]] : [])));
	} catch {
		return {};
	}
}

export function readState(path: string | undefined, id: string, engine: StateEngine): string | null {
	return loadFile(path)[stateKey(id, engine)] ?? null;
}

export function readCodexState(path: string | undefined, id: string): string | null {
	const threadId = readState(path, id, "codex");
	return isCodexThreadId(threadId) ? threadId : null;
}

export function writeState(path: string | undefined, id: string, sessionId: string | null, engine: StateEngine): void {
	if (!path) return;
	try {
		const data = loadFile(path);
		const key = stateKey(id, engine);
		if (sessionId) data[key] = sessionId;
		else delete data[key];
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(data));
	} catch {
		/* best-effort persistence */
	}
}

/** Default location for the resume-id store, under the repos base dir. */
export function defaultStatePath(reposBaseDir: string): string {
	return join(reposBaseDir, "headless-sessions.json");
}
