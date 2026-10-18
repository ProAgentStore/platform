/**
 * Which local-runtime routes a relayed command may reach, by the agent it arrived for (#1164).
 *
 * `runner connect` used to forward any method and path that arrived on a socket. One `pags up` serves
 * every agent on the machine, so a job-application agent's socket could reach `/tmux/run`, and a
 * third-party agent's could reach the coding engine. Each socket belongs to ONE agent, and that agent's
 * declared capabilities (`/v1/instances/my/instances` → `capabilities`) say which route families it
 * needs. Everything else is refused here, before the runtime sees it.
 *
 * Read from the code that sends them, not guessed:
 *   • `runtime: "coding"` drives the coding engine (`/coding/*`), and the website runtime builder queues
 *     its authoring run as a task (`/tasks`, lib/runtime-builder/workflow.ts). The engine's own sign-in
 *     reaches the browser and a takeover (`/browser/act`, `/browser/handoff`, `/takeover`), and its re-auth
 *     runs the login command in tmux — in its `pags-signin-<engine>` session only.
 *   • every agent's board reads its tasks (`GET /tasks`); creating one needs a task-running runtime.
 *   • the repo-local connector's tools (`repo_*`) read a checkout through the `/coding` read routes.
 *   • The terminal operators are `runtime: "coding"` with `surfaces: ["tmux"]` and `tmux_*`/`terminal_*`
 *     tools (migrations 0072, 0112, 0123): the terminal and the secret handoff (`/tmux`, `/terminal`,
 *     `/secure`) follow the SURFACE or those tools, not the runtime — a Repo Coder does not get a shell.
 *   • `runtime: "browser"` (job apply) runs tasks with a browser and takeovers.
 *   • each `local_*` runtime has its own route family; local apply's handoffs also use the task,
 *     browser and takeover routes (lib/local-apply/fill-handoff.ts).
 *   • the browser connector's tools (`browser_*`) act through `/browser/*` on any agent that declares them.
 *
 * This confines each agent to its kind. It is NOT a defence against whoever controls the capability
 * record (the owner's session, or a compromised API worker can change it). That needs signed commands
 * and local confirmation, which this does not do.
 */

export interface DeclaredCapabilities {
	runtime?: string | null;
	surfaces?: readonly string[] | null;
	tools?: readonly string[] | null;
}

/** Every agent: liveness, what the runtime offers, and the board's task reads (any agent's board lists them). */
const ALWAYS = ["/health", "/capabilities", "/events"];
const READ_ALWAYS = ["/tasks"];

/** A browser agent's task run: tasks, the browser, takeovers. */
const BROWSER = ["/tasks", "/browser/", "/takeover", "/sessions"];

const BY_RUNTIME: Record<string, readonly string[]> = {
	// The coding engine, the website runtime builder's task, and the engine's own SIGN-IN: the cloud relays the
	// login page through `/browser/act` + `/browser/handoff` and its card through `/takeover` (coding-sessions-open.ts).
	coding: ["/coding/", "/tasks", "/browser/act", "/browser/handoff", "/takeover"],
	browser: BROWSER,
	local_browser: ["/local-browser/"],
	local_artifact: ["/local-artifact/"],
	local_apply: ["/local-apply/", ...BROWSER],
	local_native: ["/native/"],
};

const TERMINAL = ["/tmux/", "/terminal/", "/secure/"];

/** The repo-local connector's reads (`repo_*` tools), on whatever agent declares them. */
const REPO_READS = ["/coding/tree", "/coding/read-file", "/coding/git", "/coding/search", "/coding/git-remote", "/coding/repo-check"];

/**
 * A coding agent's engine RE-AUTH (`coding_engine_reauth`, routes/coding-reauth.ts) runs the engine's login
 * command in a tmux session of its own — always `pags-signin-<engine>` (lib/engine-reauth.ts). That one session
 * is the only tmux a coding agent without the terminal surface may touch.
 */
const SIGN_IN_TMUX = new Set(["/tmux/session", "/tmux/run", "/tmux/send", "/tmux/capture"]);
const SIGN_IN_SESSION = /^pags-signin-[a-z0-9_-]+$/;

function hasTerminal(caps: DeclaredCapabilities): boolean {
	const tools = caps.tools ?? [];
	return (caps.surfaces ?? []).includes("tmux") || tools.some((t) => t.startsWith("tmux_") || t.startsWith("terminal_"));
}

/** The path prefixes an agent with these capabilities may reach (any method). */
export function allowedPrefixes(caps: DeclaredCapabilities | null | undefined): string[] {
	const out = [...ALWAYS];
	if (!caps) return out;
	if (caps.runtime && BY_RUNTIME[caps.runtime]) out.push(...BY_RUNTIME[caps.runtime]);
	const tools = caps.tools ?? [];
	if (hasTerminal(caps)) out.push(...TERMINAL);
	if (tools.some((t) => t.startsWith("browser_"))) out.push("/browser/");
	if (tools.some((t) => t.startsWith("repo_"))) out.push(...REPO_READS);
	return out;
}

/** Does `prefix` cover `path`? An exact family (`/tasks`) covers its sub-paths (`/tasks/x/approve`) too. */
function covers(prefix: string, path: string): boolean {
	if (prefix.endsWith("/")) return path.startsWith(prefix);
	return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Why this agent may not reach `method path` (with `body`), or null. `caps` undefined = not known yet: only
 * what every agent has is allowed until the capabilities are read, so an unknown agent is never a wide-open one.
 */
export function routeRefusal(caps: DeclaredCapabilities | null | undefined, path: string, method = "POST", body?: unknown): string | null {
	const clean = path.split("?")[0] ?? path;
	if (/(^|\/)\.\.(\/|$)/.test(clean)) return `Refused ${clean}: a relayed path may not climb out of its route.`;
	if (allowedPrefixes(caps).some((p) => covers(p, clean))) return null;
	if ((method === "GET" || method === "HEAD") && READ_ALWAYS.some((p) => covers(p, clean))) return null;
	if (caps?.runtime === "coding" && SIGN_IN_TMUX.has(clean)) {
		const session = (body as { session?: unknown } | undefined)?.session;
		if (typeof session === "string" && SIGN_IN_SESSION.test(session)) return null;
	}
	return `Refused ${clean}: this agent's declared capabilities do not include it, so this machine will not run it for this agent.`;
}

/**
 * Each attached agent's declared capabilities, and the refusal its socket answers with. Fed by the same
 * instance list membership reads; an agent not read yet gets only what every agent has, and a re-read.
 */
export class AgentRoutePolicy {
	private declared = new Map<string, DeclaredCapabilities | null>();
	private refreshing: Promise<void> | null = null;

	constructor(private readonly fetchInstances: () => Promise<Array<{ id: string; capabilities?: DeclaredCapabilities | null }> | undefined>) {}

	learn(instances: Array<{ id: string; capabilities?: DeclaredCapabilities | null }> | undefined): void {
		for (const inst of instances ?? []) this.declared.set(inst.id, inst.capabilities ?? null);
	}

	refresh(): Promise<void> {
		this.refreshing ??= this.fetchInstances()
			.then((instances) => this.learn(instances))
			.catch(() => undefined)
			.finally(() => {
				this.refreshing = null;
			});
		return this.refreshing;
	}

	refusalFor(id: string): (method: string, path: string, body?: unknown) => string | null {
		return (method, path, body) => {
			const caps = this.declared.get(id);
			if (caps === undefined) void this.refresh();
			return routeRefusal(caps, path, method, body);
		};
	}
}
