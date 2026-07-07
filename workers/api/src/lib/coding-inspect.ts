import { callRunner, type RunnerConn } from "./runner-client.js";

/**
 * The Co-pilot/Chat's read-only "eyes" on a coding session's real repo. These tools let
 * the brain GROUND its answer in the actual code (a file, a diff, the tree) before it
 * speaks — the read half of what the terminal Engine already does, at lower privilege.
 *
 * Design rule (see the architecture note in the plan): reads belong to the Co-pilot,
 * writes belong to the Engine. These tools never drive the CLI; they hit the runner's
 * read-only `/coding/read-file|git|tree` endpoints. Results are byte-capped and fenced
 * as UNTRUSTED data (repo code can contain adversarial text). The brain TRANSLATES what
 * it reads into plain language — it never pastes the raw output at the user.
 */

export interface InspectTarget {
	conn: RunnerConn;
	sessionId?: string;
	/** D1 `repo.workdir` fallback when the runner's session map is empty (post-restart). */
	workDir?: string;
}

/** Tool defs in the same `{type:"function", function:{...}}` shape as buildAgentToolDefinitions. */
export function buildInspectTools() {
	const fn = (name: string, description: string, properties: Record<string, { type: string; description: string }>, required: string[] = []) => ({
		type: "function" as const,
		function: { name, description, parameters: { type: "object", properties, required } },
	});
	return [
		fn("list_files", "List the repo's files/folders (names only) to see what's there. Use before assuming a feature does or doesn't exist.", {
			path: { type: "string", description: "Sub-folder to list (optional; defaults to the repo root)." },
		}),
		fn("read_file", "Read a file's contents from the repo, to check what's actually implemented.", {
			path: { type: "string", description: "File path relative to the repo root, e.g. src/App.tsx." },
		}, ["path"]),
		fn("git_status", "Show which files have uncommitted changes right now (git status).", {}),
		fn("git_diff", "Show the actual uncommitted changes (git diff) — use this to confirm what did or didn't change before claiming it.", {
			path: { type: "string", description: "Limit the diff to one file (optional)." },
		}),
	];
}

export const INSPECT_TOOL_NAMES = new Set(["list_files", "read_file", "git_status", "git_diff"]);

/** Per-call byte budgets so a huge file/diff can't blow the model context. */
const CAPS = { read_file: 8 * 1024, git_diff: 12 * 1024, list_files: 6 * 1024, git_status: 4 * 1024 };

/**
 * Execute one inspect tool against the runner. Returns a compact text result prefixed with
 * exactly what was inspected (so the brain can ground its claim on it). Never throws: an old
 * runner without these endpoints 404s → we return an "unavailable" note so the brain answers
 * from the terminal and admits it couldn't inspect the code (feeds the evidence rule).
 */
export async function executeInspectTool(target: InspectTarget, call: { name: string; arguments: Record<string, unknown> }): Promise<string> {
	const { conn, sessionId, workDir } = target;
	const base = { sessionId, workDir };
	const path = typeof call.arguments?.path === "string" ? call.arguments.path : undefined;
	try {
		switch (call.name) {
			case "list_files": {
				const r = await callRunner<{ entries?: Array<{ path: string; type: string }>; truncated?: boolean }>(conn, "/coding/tree", { ...base, path, maxDepth: 3, maxEntries: 400 });
				const list = (r.entries || []).map((e) => (e.type === "dir" ? `${e.path}/` : e.path)).join("\n");
				return clip(`Files in ${path || "repo root"}:\n${list}${r.truncated ? "\n…(more)" : ""}`, CAPS.list_files);
			}
			case "read_file": {
				if (!path) return "read_file needs a `path`.";
				const r = await callRunner<{ content?: string; binary?: boolean; truncated?: boolean }>(conn, "/coding/read-file", { ...base, path, maxBytes: CAPS.read_file });
				if (r.binary) return `${path} is a binary file (not shown).`;
				return clip(`Contents of ${path}${r.truncated ? " (truncated)" : ""}:\n${r.content ?? ""}`, CAPS.read_file);
			}
			case "git_status": {
				const r = await callRunner<{ output?: string }>(conn, "/coding/git", { ...base, cmd: "status" });
				const out = (r.output || "").trim();
				return out ? clip(`Uncommitted changes (git status):\n${out}`, CAPS.git_status) : "git status: no uncommitted changes (working tree clean).";
			}
			case "git_diff": {
				const r = await callRunner<{ output?: string; truncated?: boolean }>(conn, "/coding/git", { ...base, cmd: "diff", path });
				const out = (r.output || "").trim();
				return out ? clip(`Changes (git diff${path ? ` ${path}` : ""})${r.truncated ? " (truncated)" : ""}:\n${out}`, CAPS.git_diff) : "git diff: nothing changed (no uncommitted edits).";
			}
			default:
				return `Unknown inspection tool: ${call.name}`;
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		// Old runner (endpoint 404) or offline → degrade honestly.
		if (/40[0-9]|not found|no runner/i.test(msg)) {
			return "Code inspection isn't available on this runner (it may be an older version or offline). Answer from the terminal only, and say you couldn't check the code directly.";
		}
		return `Inspection failed: ${msg.slice(0, 200)}`;
	}
}

function clip(s: string, cap: number): string {
	return s.length > cap ? `${s.slice(0, cap)}\n…(truncated)` : s;
}
