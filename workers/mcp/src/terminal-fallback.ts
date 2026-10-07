/**
 * The coding session tools, for an instance whose "session" is a bare terminal (#878).
 *
 * A terminal-operator instance (tmux.control, no repo) never has a coding session: that record
 * needs a repo, and the instance drives its machine through the `tmux_*` / `terminal_*` connector
 * tools instead. So `coding_session_capture` answered "No active coding session found." and
 * `coding_session_message` demanded `coding_repo_add` — a repo the instance has no use for — while
 * the terminal it HAD been using sat one `call_instance_tool` away.
 *
 * These helpers resolve that terminal the way the console does: the target the owner selected
 * (`activeTerminalTarget`), else the one last driven (`lastTerminalTarget`, recorded by use and
 * kept after the tmux session ends — `workers/api/src/lib/terminal-record.ts`). They act through
 * `POST /v1/instances/:id/tools/:name`, the SAME dispatch `call_instance_tool` uses, so the
 * instance's tool policy, the owner's write consent and any bound-target ceiling all apply
 * unchanged. Nothing here reaches a terminal by any other road.
 *
 * Only for an instance with NO repo: with one, the coding session is the thing to talk to, and the
 * callers keep their behaviour exactly.
 */
import { clipMarked } from "./clip-marked.js";

/** An authenticated API call — `authedCall` bound to one token and env. */
export type ApiCall = (path: string, init?: RequestInit) => Promise<unknown>;

/** How one tool family addresses a terminal, and which of its tools do what. */
export interface TerminalFamily {
	family: "terminal" | "tmux";
	capture: string;
	send: string;
	/** Opens a tmux target of this name again — tmux targets only. */
	create: string;
	address(target: string): Record<string, unknown>;
	createInput(target: string): Record<string, unknown>;
}

const TERMINAL: TerminalFamily = {
	family: "terminal",
	capture: "terminal_capture",
	send: "terminal_send_message",
	create: "terminal_new_target",
	address: (target) => ({ target }),
	createInput: (target) => ({ backend: "tmux", name: tmuxName(target) }),
};

const TMUX: TerminalFamily = {
	family: "tmux",
	capture: "tmux_capture_pane",
	send: "tmux_send_message",
	create: "tmux_new_session",
	address: (target) => ({ session: tmuxName(target) }),
	createInput: (target) => ({ session: tmuxName(target) }),
};

/** `tmux:shell` → `shell`; a bare name is already one. */
export function tmuxName(target: string): string {
	return target.startsWith("tmux:") ? target.slice("tmux:".length) : target;
}

/** A target the tmux family can address: prefixed `tmux:` or bare (tmux is the default backend). */
function isTmuxTarget(target: string): boolean {
	return target.startsWith("tmux:") || !target.includes(":");
}

/**
 * Which family reaches `target` for `need`, given the tools this instance may run. The generic
 * `terminal_*` family first — it addresses every backend — and `tmux_*` for a tmux target when that
 * is the family the agent declares (#409 made the two families independent).
 */
export function terminalFamilyFor(allowed: ReadonlySet<string>, target: string, need: "capture" | "send"): TerminalFamily | null {
	for (const f of [TERMINAL, TMUX]) {
		if (f === TMUX && !isTmuxTarget(target)) continue;
		if (allowed.has(f[need])) return f;
	}
	return null;
}

/** Does this instance declare ANY terminal tool? Decides whether the fallback applies at all. */
export function hasTerminalTools(allowed: ReadonlySet<string>): boolean {
	return [TERMINAL, TMUX].some((f) => allowed.has(f.capture) || allowed.has(f.send));
}

/** The runner's words for a tmux session that is not there — the case a reattach answers. */
export function isMissingTerminal(content: string): boolean {
	return /no tmux session|can't find session|session not found|no such session|no server running/i.test(content);
}

interface ToolResult {
	success?: boolean;
	content?: string;
	error?: string;
}

async function runTool(api: ApiCall, instanceId: string, tool: string, input: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const r = (await api(`/v1/instances/${encodeURIComponent(instanceId)}/tools/${encodeURIComponent(tool)}`, { method: "POST", body: JSON.stringify(input) })) as ToolResult;
	if (r?.error) return { ok: false, content: r.error };
	return { ok: r?.success === true, content: String(r?.content ?? "") };
}

export interface TerminalContext {
	/** The selected target, else the last one driven. Null when neither was ever recorded. */
	target: string | null;
	/** Which of the two it is, for saying so. */
	origin: "selected" | "last_used" | null;
	allowed: Set<string>;
}

/** The instance's terminal, and the tools it may run — or an API error to surface as-is. */
export async function readTerminalContext(api: ApiCall, instanceId: string): Promise<TerminalContext | { error: string }> {
	const id = encodeURIComponent(instanceId);
	const [sessionData, toolData] = await Promise.all([
		api(`/v1/instances/${id}/terminal-session`) as Promise<{ activeTerminalTarget?: string | null; lastTerminalTarget?: string | null; error?: string }>,
		api(`/v1/instances/${id}/tools?allowed=true`) as Promise<{ tools?: Array<{ name: string; allowed?: boolean }>; error?: string }>,
	]);
	if (toolData?.error) return { error: toolData.error };
	const allowed = new Set((toolData?.tools ?? []).filter((t) => t.allowed !== false).map((t) => t.name));
	const active = sessionData?.activeTerminalTarget || null;
	const last = sessionData?.lastTerminalTarget || null;
	return { target: active ?? last, origin: active ? "selected" : last ? "last_used" : null, allowed };
}

/**
 * `coding_session_capture` for a repo-less terminal: the live pane when the target is still there,
 * else the last pane the platform stored for it — said as such, with when it was taken. Null when
 * the instance has no terminal tools, so the caller's own answer stands.
 */
export async function captureTerminal(api: ApiCall, instanceId: string, repos: { repos: unknown[] } | { error: string }): Promise<Record<string, unknown> | null> {
	// An instance with a repo keeps its own answer: its coding session is the thing to read.
	if ("error" in repos || repos.repos.length > 0) return null;
	const ctx = await readTerminalContext(api, instanceId);
	if ("error" in ctx) return { error: ctx.error };
	if (!hasTerminalTools(ctx.allowed)) return null;
	if (!ctx.target) {
		return {
			source: "none",
			terminalTarget: null,
			detail: "No coding session, and no terminal has been used on this agent yet — list them with call_instance_tool (tmux_list_sessions / terminal_list_targets).",
		};
	}
	const family = terminalFamilyFor(ctx.allowed, ctx.target, "capture");
	const live = family ? await runTool(api, instanceId, family.capture, { ...family.address(ctx.target), lines: 200 }).catch((e) => ({ ok: false, content: String(e) })) : null;
	if (live?.ok) return { source: "live", terminalTarget: ctx.target, targetOrigin: ctx.origin, pane: live.content };
	// The terminal is gone (or unreadable): the stored record is the answer #878 asked for.
	const stored = (await api(`/v1/instances/${encodeURIComponent(instanceId)}/terminal-history?terminal=1&limit=1`)) as {
		entries?: Array<{ content?: string; createdAt?: string; target?: string }>;
		hasMore?: boolean;
		oldestSeq?: number | null;
		error?: string;
	};
	const last = stored?.entries?.[stored.entries.length - 1];
	return {
		source: last ? "stored" : "none",
		terminalTarget: ctx.target,
		targetOrigin: ctx.origin,
		live: false,
		// Marked, not silently cut (#959): an agent reads this as the reason the live read failed.
		...(live ? { liveError: clipMarked(live.content, 400) } : {}),
		...(last
			? {
					capturedAt: last.createdAt,
					pane: last.content,
					detail: `${ctx.target} could not be read live, so this is the last pane the platform stored for it (${last.createdAt}). Older snapshots: coding_terminal; what was typed: coding_timeline.`,
				}
			: { detail: `${ctx.target} could not be read live and no pane of it was ever stored.` }),
	};
}

/**
 * `coding_session_message` for a repo-less terminal: send to its target, and when a tmux target has
 * ended, open it again under the same name and send there — the reattach #878 asked for. Null when
 * the instance has no terminal tools, so the caller's own answer stands.
 */
export async function messageTerminal(api: ApiCall, instanceId: string, message: string): Promise<{ text: string; target?: string; reopened?: boolean; sent: boolean } | null> {
	const ctx = await readTerminalContext(api, instanceId);
	if ("error" in ctx) return { text: `Error reading this agent's terminal: ${ctx.error}`, sent: false };
	if (!hasTerminalTools(ctx.allowed)) return null;
	if (!ctx.target) {
		return {
			text: "This agent has no repo and no terminal it has used yet, so there is nothing to send this to. Open one with call_instance_tool (tmux_new_session or terminal_new_target), or pick an existing one with set_instance_terminal_session — then send this again.",
			sent: false,
		};
	}
	const target = ctx.target;
	const family = terminalFamilyFor(ctx.allowed, target, "send");
	if (!family) return { text: `This agent may not type into ${target}: neither terminal_send_message nor tmux_send_message is allowed for it.`, target, sent: false };
	const which = ctx.origin === "selected" ? "the selected terminal" : "the terminal last used on this agent";
	let sent = await runTool(api, instanceId, family.send, { ...family.address(target), message });
	let reopened = false;
	if (!sent.ok && isTmuxTarget(target) && isMissingTerminal(sent.content) && ctx.allowed.has(family.create)) {
		const made = await runTool(api, instanceId, family.create, family.createInput(target));
		if (!made.ok) return { text: `${target} (${which}) has ended, and opening it again failed: ${made.content}`, target, sent: false };
		reopened = true;
		sent = await runTool(api, instanceId, family.send, { ...family.address(target), message });
	}
	const note = reopened ? ` Its tmux session had ended, so a new one was opened under the same name — a fresh shell; what ran in the old one is in coding_terminal and coding_timeline.` : "";
	if (!sent.ok) return { text: `Error sending to ${target} (${which}):${note} ${sent.content}`, target, reopened, sent: false };
	return { text: `Sent to ${target} (${which}): "${message}".${note} Read the result with coding_session_capture.`, target, reopened, sent: true };
}
