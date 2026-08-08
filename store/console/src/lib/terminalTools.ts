/**
 * Which terminal tool FAMILY the Terminal tab is allowed to drive, and what its calls look like
 * (#409).
 *
 * The tab used to name `terminal_*` literally. That was correct for as long as every agent on the
 * `tmux` surface declared the generic terminal connector — and #403 ended that: the tmux Operator
 * declares the six backend-exclusive `tmux_*` tools instead, because `terminal_list_targets`
 * defaults to `backend:"all"` and an agent sold as a tmux agent was reading the owner's kitty
 * windows and iTerm2 tabs. So the tab's two READ calls started 403ing on a published catalog agent,
 * every four seconds, under an empty state that told the reader to go open a tmux session.
 *
 * The two families are NOT a rename. Four shapes differ, and a swap that missed any of them would
 * look like it had worked:
 *
 *   | | `terminal_*` | `tmux_*` |
 *   |---|---|---|
 *   | address | `target: "tmux:main"` (backend-prefixed) | `session: "main"` |
 *   | create | `{backend, name, workDir, command}` | `{session, workDir, command}` |
 *   | keys | `keys: string[]` | `keys: "Enter,C-c"` (comma-separated) |
 *   | list rows | `{backend, id, name, …}` | `{name, windows, …}` — **no `backend`, no `id`** |
 *
 * That last row is the trap the ticket names: the old `parseTargets` dropped any row lacking both
 * `backend` and `id`, so a name-only swap yields a silently EMPTY target list — a worse failure
 * than the 403, because it reads as a working tab on a machine with nothing running. The tmux rows
 * are given their backend HERE, in the console, rather than by teaching the runner to emit one:
 * `pags up` is an installed npm package on someone else's machine, so a fix that needs a new runner
 * is a fix that does not reach the person who has the bug until they upgrade.
 *
 * Pure, and separate from the component, for the reason `tmuxView.ts` already gives: this console
 * has no component-testing infrastructure (#282), so a function is the only shape of a decision a
 * test can hold.
 */

export type TerminalBackend = "tmux" | "kitty" | "iterm2";

/** A row of the target list, after both families are normalised onto one shape. */
export interface TerminalTarget {
	backend: TerminalBackend;
	id: string;
	name: string;
	windows?: number;
	attached?: boolean;
	activeCommand?: string;
	activeWindow?: string;
	created?: string;
}

/**
 * One family of tools the tab can drive.
 *
 * The names live HERE and nowhere else in the console tree — `lib/toolLiterals.test.ts` is the
 * ratchet that keeps it that way, because a tool name written inline in a component is a name
 * nothing checks the agent still declares. That is the whole defect of #409, authored in `6cbd8dc`
 * five days before the migration that broke it, with nothing objecting.
 */
export interface TerminalToolFamily {
	id: "terminal" | "tmux";
	/** The connector the write-consent row is keyed by (`instance_connector_consent`). */
	connector: string;
	/** What this family can reach — the create form may only offer these. */
	backends: readonly TerminalBackend[];
	/** What one of them is called, in prose. `terminal_*` addresses "targets"; tmux has sessions. */
	noun: string;
	list: string;
	capture: string;
	run: string;
	sendKeys: string;
	create: string;
	kill: string;
}

export const TERMINAL_FAMILY: TerminalToolFamily = {
	id: "terminal",
	connector: "terminal",
	backends: ["tmux", "kitty", "iterm2"],
	noun: "target",
	list: "terminal_list_targets",
	capture: "terminal_capture",
	run: "terminal_run_command",
	sendKeys: "terminal_send_keys",
	create: "terminal_new_target",
	kill: "terminal_kill_target",
};

export const TMUX_FAMILY: TerminalToolFamily = {
	id: "tmux",
	connector: "tmux",
	backends: ["tmux"],
	noun: "session",
	list: "tmux_list_sessions",
	capture: "tmux_capture_pane",
	run: "tmux_run_command",
	sendKeys: "tmux_send_keys",
	create: "tmux_new_session",
	kill: "tmux_kill_session",
};

/**
 * Preference order. `terminal` first so the three Operators that kept the generic connector
 * (`terminal-operator`, `kitty-operator`, `iterm-operator`) behave exactly as they did — they share
 * this one file with the agent whose tools changed, and fixing one of four by breaking three is the
 * regression this tab is one commit away from at all times.
 */
export const TERMINAL_TOOL_FAMILIES: readonly TerminalToolFamily[] = [TERMINAL_FAMILY, TMUX_FAMILY];

/** Every tool name this tab can ever call — what the ratchet cross-checks against the registry. */
export function terminalFamilyToolNames(family: TerminalToolFamily): string[] {
	return [family.list, family.capture, family.run, family.sendKeys, family.create, family.kill];
}

/**
 * What the tab may do, resolved from the instance's own `GET /tools?allowed=true`.
 *
 * `loading` is a first-class state and not "unsupported yet": the policy is a round trip, and
 * rendering "this agent has no terminal tools" for the 200ms before it lands is the same flicker
 * #378 spent a ticket removing, pointed the other way.
 */
export type TerminalToolAccess =
	| { state: "loading" }
	| { state: "unsupported"; needs: readonly string[] }
	| { state: "ready"; family: TerminalToolFamily; canCapture: boolean };

/**
 * Pick the family this agent can actually drive.
 *
 * A family is drivable when its LIST tool is declared — that is the call the tab cannot do without,
 * and it is the one whose absence produced the false "No terminal targets found on <machine>".
 * `capture` is reported separately rather than folded into the same test, because `1f3ca00`/#351
 * established that this tab gates per TOOL and not per surface: an agent that can list but not
 * capture should get a list and an honest pane, not a dead tab.
 */
export function resolveTerminalAccess(allowed: ReadonlySet<string> | null): TerminalToolAccess {
	if (!allowed) return { state: "loading" };
	const family = TERMINAL_TOOL_FAMILIES.find((f) => allowed.has(f.list));
	if (!family) return { state: "unsupported", needs: TERMINAL_TOOL_FAMILIES.map((f) => f.list) };
	return { state: "ready", family, canCapture: allowed.has(family.capture) };
}

/** The four write controls, gated one at a time — `1f3ca00`'s shipped promise, not one `canWrite`. */
export interface TerminalWriteAccess {
	run: boolean;
	sendKeys: boolean;
	create: boolean;
	kill: boolean;
	any: boolean;
}

export function resolveTerminalWrites(family: TerminalToolFamily | null, allowed: ReadonlySet<string> | null): TerminalWriteAccess {
	const has = (name: string | undefined) => !!name && !!allowed && allowed.has(name);
	const run = has(family?.run);
	const sendKeys = has(family?.sendKeys);
	const create = has(family?.create);
	const kill = has(family?.kill);
	return { run, sendKeys, create, kill, any: run || sendKeys || create || kill };
}

// ── Addressing ───────────────────────────────────────────────────────────────
//
// The tab's selection stays a `backend:id` key in BOTH families, so the list, the header, the
// selected-target lookup and the phone view switch are untouched. Only the call arguments differ,
// and they are built here.

export function targetKey(t: Pick<TerminalTarget, "backend" | "id">): string {
	return `${t.backend}:${t.id}`;
}

/**
 * The key as this family addresses it: the whole `tmux:main` for the generic connector, the bare
 * `main` for tmux. Split on the FIRST colon only — a tmux session name may legally contain one, and
 * `tmux:a:b` addresses the session `a:b`.
 */
export function addressFor(family: TerminalToolFamily, key: string): string {
	if (family.id !== "tmux") return key;
	const i = key.indexOf(":");
	return i === -1 ? key : key.slice(i + 1);
}

/** `{target}` or `{session}` — the one difference every call below is built on. */
function addressArg(family: TerminalToolFamily, key: string): Record<string, string> {
	return family.id === "tmux" ? { session: addressFor(family, key) } : { target: key };
}

export function captureArgs(family: TerminalToolFamily, key: string, lines: number): Record<string, unknown> {
	return { ...addressArg(family, key), lines };
}

export function runArgs(family: TerminalToolFamily, key: string, command: string): Record<string, unknown> {
	return { ...addressArg(family, key), command };
}

/**
 * `terminal_send_keys` takes an ARRAY; `tmux_send_keys` takes a comma-separated STRING and splits it
 * itself. Sending the wrong one sends no keys and reports no error: the tmux connector reads `keys`
 * as `String(input.keys ?? "")`, and `["Enter"]` stringifies to `Enter` — so a single key would work
 * by coincidence and `["C-c","Enter"]` would depend on JS array stringification putting a comma
 * there. Built explicitly rather than left to that.
 */
export function sendKeysArgs(family: TerminalToolFamily, key: string, text: string, keys: readonly string[]): Record<string, unknown> {
	return {
		...addressArg(family, key),
		text: text || undefined,
		keys: family.id === "tmux" ? keys.join(",") : [...keys],
	};
}

export function killArgs(family: TerminalToolFamily, key: string): Record<string, unknown> {
	return addressArg(family, key);
}

export function createArgs(
	family: TerminalToolFamily,
	opts: { backend: TerminalBackend; name: string; workDir?: string; command?: string },
): Record<string, unknown> {
	const rest = { workDir: opts.workDir || undefined, command: opts.command || undefined };
	return family.id === "tmux"
		? { session: opts.name, ...rest }
		: { backend: opts.backend, name: opts.name, ...rest };
}

/**
 * Which target to select after a create.
 *
 * `terminal_new_target` returns the created target as JSON; `tmux_new_session` returns an English
 * sentence. Both fall back to the name we asked for, which is what tmux guarantees — the session is
 * named exactly what you named it, or one under that name already existed.
 */
export function createdTargetKey(family: TerminalToolFamily, raw: string, backend: TerminalBackend, name: string): string {
	const fallback = `${family.id === "tmux" ? "tmux" : backend}:${name}`;
	if (family.id === "tmux") return fallback;
	try {
		const parsed = JSON.parse(raw || "{}") as Record<string, unknown> & { target?: Record<string, unknown> };
		const t = (parsed.target ?? parsed) as Record<string, unknown>;
		const b = typeof t.backend === "string" ? t.backend : "";
		const id = typeof t.id === "string" ? t.id : "";
		return b && id ? `${b}:${id}` : fallback;
	} catch {
		return fallback;
	}
}

// ── Reading the list ─────────────────────────────────────────────────────────

function asBackend(v: unknown): TerminalBackend | null {
	return v === "tmux" || v === "kitty" || v === "iterm2" ? v : null;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v ? v : undefined;
}

/**
 * Parse whichever list the family returned into one row shape.
 *
 * A `tmux_list_sessions` row carries a NAME and nothing that identifies a backend, because the tool
 * is backend-exclusive and the backend is therefore a property of the TOOL rather than of the row.
 * Supplying `tmux` here is the whole reason the runner did not have to change.
 */
export function parseTargets(family: TerminalToolFamily, content?: string): TerminalTarget[] {
	if (!content) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.flatMap((item): TerminalTarget[] => {
		if (!item || typeof item !== "object") return [];
		const row = item as Record<string, unknown>;
		const name = str(row.name);
		const backend = family.id === "tmux" ? "tmux" : asBackend(row.backend);
		const id = family.id === "tmux" ? (name ?? "") : (str(row.id) ?? "");
		if (!backend || !id) return [];
		return [{
			backend,
			id,
			name: name ?? id,
			windows: typeof row.windows === "number" ? row.windows : undefined,
			attached: typeof row.attached === "boolean" ? row.attached : undefined,
			activeCommand: str(row.activeCommand),
			activeWindow: str(row.activeWindow),
			created: str(row.created),
		}];
	});
}
