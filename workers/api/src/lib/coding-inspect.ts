import { callRunner, type RunnerConn } from "./runner-client.js";
import { READ_FETCH_BYTES, renderRepoFileWindow } from "./repo-file-window.js";
import { canReadHosted, hostedCoordinate, listHostedIssues, readHostedIssue, type HostedRepoRef } from "./hosted-repo.js";
import type { Env } from "../types.js";

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
	/** Present → the issue tools can answer from the repo's host (cloud-side, no runner call). */
	env?: Env;
	userId?: string;
	/**
	 * The repo, not its GitHub coordinate (#221). Which host to ask is the repo's business, and
	 * passing `owner/repo` down here is what made the Co-pilot tell a working GitLab repo it had
	 * no issues to read while the console's Issues panel was listing them.
	 */
	repo?: HostedRepoRef;
}

/**
 * Tool defs in the same `{type:"function", function:{...}}` shape as buildAgentToolDefinitions.
 * Pass `{ issues: true }` to also offer the read-only issue tools (only do so when the repo's
 * host can actually be asked — `canReadHosted(repo, "issues")`; a local-only repo has none).
 */
export function buildInspectTools(opts: { code?: boolean; issues?: boolean } = {}) {
	const { code = true, issues = false } = opts;
	const fn = (name: string, description: string, properties: Record<string, { type: string; description: string }>, required: string[] = []) => ({
		type: "function" as const,
		function: { name, description, parameters: { type: "object", properties, required } },
	});
	const tools: ReturnType<typeof fn>[] = [];
	if (code) {
		tools.push(
			fn("list_files", "List the repo's files/folders (names only) to see what's there. Use before assuming a feature does or doesn't exist.", {
				path: { type: "string", description: "Sub-folder to list (optional; defaults to the repo root)." },
			}),
			fn("read_file", "Read a file's contents from the repo, to check what's actually implemented. A large file comes back as a WINDOW of numbered lines that says which lines you got and how to ask for the next ones — read on with `startLine` instead of assuming the file ends there.", {
				path: { type: "string", description: "File path relative to the repo root, e.g. src/App.tsx." },
				startLine: { type: "number", description: "First line to return — 1-based and inclusive (default 1)." },
				endLine: { type: "number", description: "Last line to return — 1-based and inclusive (optional)." },
			}, ["path"]),
			fn("git_status", "Show which files have uncommitted changes right now (git status).", {}),
			fn("git_diff", "Show the actual uncommitted changes (git diff) — use this to confirm what did or didn't change before claiming it.", {
				path: { type: "string", description: "Limit the diff to one file (optional)." },
			}),
		);
	}
	if (issues) {
		tools.push(
			fn("list_issues", "List the repo's open issues (number + title) so you know the backlog before answering 'what's next / what's open'.", {
				state: { type: "string", description: "open (default), closed, or all." },
				labels: { type: "string", description: "Comma-separated label filter (optional), e.g. bug,ui." },
			}),
			fn("read_issue", "Read one issue's title + description, to explain what it asks for.", {
				number: { type: "number", description: "The issue number, e.g. 42." },
			}, ["number"]),
		);
	}
	return tools;
}

export const INSPECT_TOOL_NAMES = new Set(["list_files", "read_file", "git_status", "git_diff"]);
export const ISSUE_TOOL_NAMES = new Set(["list_issues", "read_issue"]);
/** Every read tool the co-pilot recognizes (code + issues). */
export const ALL_INSPECT_TOOL_NAMES = new Set([...INSPECT_TOOL_NAMES, ...ISSUE_TOOL_NAMES]);

/** Per-call budgets so a huge file/diff can't blow the model context. Bytes, except `read_file`,
 *  which is now the CHARACTER budget of a line window (#534) — deliberately left at this reader's
 *  own 8,192 rather than raised to the Assistant's 20,000, so the Co-pilot gains the range and the
 *  numbers without its per-turn token cost moving at all. */
const CAPS = { read_file: 8 * 1024, git_diff: 12 * 1024, list_files: 6 * 1024, git_status: 4 * 1024, issues: 4 * 1024, issue: 8 * 1024 };

/**
 * Execute an issue read tool (cloud-side, NO runner call — works on any runner version, against
 * whichever host the repo lives on). Returns a compact text result the brain translates to plain
 * language. Never throws.
 */
async function executeIssueTool(target: InspectTarget, call: { name: string; arguments: Record<string, unknown> }): Promise<string> {
	const { env, userId, repo } = target;
	if (!env || !repo || !canReadHosted(repo, "issues")) {
		return "Issue access needs a repo on a host PAGS can read (GitHub or GitLab) — this one isn't, so you can't read its issues.";
	}
	const githubRepo = hostedCoordinate(repo);
	if (call.name === "list_issues") {
		const state = typeof call.arguments?.state === "string" && ["open", "closed", "all"].includes(call.arguments.state) ? (call.arguments.state as "open" | "closed" | "all") : "open";
		const labels = typeof call.arguments?.labels === "string" ? call.arguments.labels : undefined;
		const issues = await listHostedIssues(env, userId ?? "", repo, { state, labels });
		if (!issues.length) return `No ${state} issues found on ${githubRepo} (or it is private and PAGS has no credential for it).`;
		const lines = issues.map((i) => `#${i.number}: ${i.title}${i.labels.length ? ` [${i.labels.join(", ")}]` : ""}`).join("\n");
		return clip(`${state} issues on ${githubRepo}:\n${lines}`, CAPS.issues);
	}
	if (call.name === "read_issue") {
		const number = typeof call.arguments?.number === "number" ? call.arguments.number : Number.parseInt(String(call.arguments?.number ?? ""), 10);
		if (!Number.isFinite(number)) return "read_issue needs a `number`.";
		const issue = await readHostedIssue(env, userId ?? "", repo, number);
		if (!issue) return `Issue #${number} wasn't found on ${githubRepo} (it may be a pull request, or the repo is private and PAGS has no credential for it).`;
		return clip(`Issue #${issue.number}: ${issue.title}${issue.labels.length ? `\nLabels: ${issue.labels.join(", ")}` : ""}\n\n${issue.body || "(no description)"}`, CAPS.issue);
	}
	return `Unknown issue tool: ${call.name}`;
}

/**
 * Execute one inspect tool against the runner. Returns a compact text result prefixed with
 * exactly what was inspected (so the brain can ground its claim on it). Never throws: an old
 * runner without these endpoints 404s → we return an "unavailable" note so the brain answers
 * from the terminal and admits it couldn't inspect the code (feeds the evidence rule).
 */
export async function executeInspectTool(target: InspectTarget, call: { name: string; arguments: Record<string, unknown> }): Promise<string> {
	// Issue tools are cloud→GitHub — no runner needed (work on any runner version).
	if (ISSUE_TOOL_NAMES.has(call.name)) {
		try {
			return await executeIssueTool(target, call);
		} catch (e) {
			return `Couldn't read issues: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
		}
	}
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
				// The SECOND reader of the same files (#534). This carried the identical defect the
				// ticket is about — an 8KB byte cap, no range, and a disclosure that was the single
				// word "(truncated)" with no numbers — so the Co-pilot and the Assistant could
				// disagree about what a file contains. It takes the same window, keeping its OWN
				// smaller budget: the fix here is the range and the honest header, not more tokens.
				const r = await callRunner<{ content?: string; binary?: boolean; truncated?: boolean; size?: number }>(conn, "/coding/read-file", { ...base, path, maxBytes: READ_FETCH_BYTES });
				if (r.binary) return `${path} is a binary file (not shown).`;
				return renderRepoFileWindow({
					path,
					content: r.content ?? "",
					size: r.size,
					fetchTruncated: r.truncated,
					startLine: call.arguments?.startLine,
					endLine: call.arguments?.endLine,
					maxChars: CAPS.read_file,
				}).content;
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
